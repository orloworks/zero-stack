import { env } from "void/env";
import { auditRow } from "./admin";
import { parseInvite, type InviteKind } from "./lib/invite-entry";
import { send } from "./mail";
import { signupAllowed } from "./signup-allowlist";

// Invites: who may sign up. The SIGNUP_ALLOWLIST secret and the invite table are two sources of one list. Pages call these functions, never the table.
// Every change writes its audit entry in the same db.batch, so a change is never unrecorded.

export const INVITED_EMAIL = (entry: string) => `Invited ${entry}.`;
export const INVITED_DOMAIN = (entry: string) => `Invited anyone at ${entry}.`;
export const INVITE_REMOVED = "Invite removed.";
export const INVITE_EMAIL_REQUESTED = (entry: string) => `Invite email requested for ${entry}.`;
export const STILL_INVITED = "Still invited through SIGNUP_ALLOWLIST.";
export const STILL_INVITED_DOMAIN = (domain: string) => `Still invited through ${domain}.`;
export const RESEND_TOO_SOON = "An invite was just sent. Try again in a minute.";
const RESEND_MS = 60_000;
const GONE = "That invite is already gone.";
export const EXISTING_ACCOUNTS = "Existing accounts are not affected. Ban the user to block them.";

type Actor = { id: string; email: string };
type Result<T = object> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 429; message: string };

// void/db and @schema are imported on use: Void's plugin loads auth.ts (and so this file) at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")), ...(await import("../.void/better-auth-schema")) });

type Store = Awaited<ReturnType<typeof store>>;

// An audit row that is written only while the invite still exists, placed before the batch's own delete or update: a request that lost a race to another one
// finds no invite, so it writes nothing (one entry per change that happened, never one per request).
const auditWhileInvite = ({ db, sql, eq, invite, auditEntry }: Store, id: string, row: ReturnType<typeof auditRow>) =>
  db.insert(auditEntry).select((qb) =>
    qb
      .select(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sql`${v instanceof Date ? v.getTime() : v}`.as(k)])) as never)
      .from(invite)
      .where(eq(invite.id, id)) as never,
  );

// The secret's entries, lower case, for the read-only list on the Invites page.
export const secretEntries = (list: unknown): string[] => [
  ...new Set((typeof list === "string" ? list : "").toLowerCase().split(/[\s,]+/).filter(Boolean)),
];

// A database entry is covered by the secret when the secret would admit it by itself: the same domain entry, or an address the secret admits.
export const coveredBySecret = (entry: string, list: unknown): boolean =>
  entry.startsWith("@") ? secretEntries(list).includes(entry) : signupAllowed(list, entry);

// The database entries that could admit this address: its exact lower-cased form and its @domain. The matcher below decides, with its own validation.
const loadEntries = async (candidates: string[]): Promise<string[]> => {
  const { db, inArray, invite } = await store();
  return (await db.select({ entry: invite.entry }).from(invite).where(inArray(invite.entry, candidates))).map((r) => r.entry);
};

// E10: the env list OR the matching database rows, through the same matcher.
// `list` is the SIGNUP_ALLOWLIST value (auth.ts has it from defineAuth's env); `load` is injectable for the generated test.
export async function inviteAllowed(email: string, list: unknown, load: (candidates: string[]) => Promise<string[]> = loadEntries): Promise<boolean> {
  if (signupAllowed(list, email)) return true;
  const addr = email.trim().toLowerCase();
  const at = addr.indexOf("@");
  if (at < 1) return false;
  return signupAllowed((await load([addr, addr.slice(at)])).join(","), email);
}

export async function listInvites() {
  const { db, desc, eq, invite, userTable } = await store();
  // shortcut: no paging; an app with thousands of invites should invite by domain.
  return db
    .select({ id: invite.id, entry: invite.entry, createdAt: invite.createdAt, lastSentAt: invite.lastSentAt, addedBy: userTable.email })
    .from(invite)
    .leftJoin(userTable, eq(invite.addedByUserId, userTable.id))
    .orderBy(desc(invite.createdAt));
}

export async function addInvite(actor: Actor, kind: InviteKind, raw: string): Promise<Result<{ entry: string; message: string }>> {
  const parsed = parseInvite(kind, raw);
  if ("error" in parsed) return { ok: false, status: 400, message: parsed.error };
  const { entry } = parsed;
  const { db, eq, invite, auditEntry } = await store();
  if ((await db.select({ id: invite.id }).from(invite).where(eq(invite.entry, entry)).limit(1))[0]) return { ok: false, status: 409, message: `${entry} is already invited.` };
  try {
    await db.batch([
      db.insert(invite).values({ id: crypto.randomUUID(), entry, addedByUserId: actor.id, createdAt: new Date() }),
      db.insert(auditEntry).values(auditRow({ actor, verb: "invite", target: { id: null, email: entry }, detail: kind })),
    ]);
  } catch (e) {
    // A concurrent add of the same entry won (UNIQUE(entry)); the batch rolled back, so nothing is audited twice.
    if (/UNIQUE/i.test(`${(e as Error)?.message} ${((e as Error)?.cause as Error | undefined)?.message}`)) return { ok: false, status: 409, message: `${entry} is already invited.` };
    throw e;
  }
  return { ok: true, entry, message: kind === "domain" ? INVITED_DOMAIN(entry) : INVITED_EMAIL(entry) };
}

// Removes the invite only: an account that already exists is never touched. The notes say whether the door is really closed.
export async function revokeInvite(actor: Actor, id: string): Promise<Result<{ message: string; notes: string[] }>> {
  const st = await store();
  const { db, eq, invite } = st;
  const row = (await db.select().from(invite).where(eq(invite.id, id)).limit(1))[0];
  if (!row) return { ok: false, status: 404, message: GONE };
  const [, deleted] = await db.batch([
    auditWhileInvite(st, id, auditRow({ actor, verb: "revoke-invite", target: { id: null, email: row.entry } })),
    db.delete(invite).where(eq(invite.id, id)).returning({ id: invite.id }),
  ]);
  if (!deleted.length) return { ok: false, status: 404, message: GONE };
  // An exact email may still be admitted by a domain invite that remains.
  const domain = row.entry.startsWith("@") ? null : row.entry.slice(row.entry.indexOf("@"));
  const viaDomain = domain && (await db.select({ id: invite.id }).from(invite).where(eq(invite.entry, domain)).limit(1))[0];
  return { ok: true, message: INVITE_REMOVED, notes: [...(coveredBySecret(row.entry, env.SIGNUP_ALLOWLIST) ? [STILL_INVITED] : []), ...(viaDomain && domain ? [STILL_INVITED_DOMAIN(domain)] : []), EXISTING_ACCOUNTS] };
}

// Mails the invitee the sign-up link. The mail goes first: a failed send (it throws) records nothing. Then the sent time and the audit entry are written together.
export async function sendInvite(actor: Actor, id: string, signUpUrl: string): Promise<Result<{ message: string }>> {
  const st = await store();
  const { db, eq, and, or, isNull, lt, invite } = st;
  const row = (await db.select().from(invite).where(eq(invite.id, id)).limit(1))[0];
  if (!row) return { ok: false, status: 404, message: GONE };
  if (row.entry.startsWith("@")) return { ok: false, status: 400, message: "Only an exact email can be sent an invite." };
  // Claim the send slot before mailing, so two clicks at once mail once: only one request's conditional update matches.
  const now = new Date();
  const claimed = await db
    .update(invite)
    .set({ lastSentAt: now })
    .where(and(eq(invite.id, id), or(isNull(invite.lastSentAt), lt(invite.lastSentAt, new Date(now.getTime() - RESEND_MS)))))
    .returning({ id: invite.id });
  if (!claimed.length) {
    // Nothing claimed: either a send just went out, or the invite was deleted since the read.
    const still = (await db.select({ id: invite.id }).from(invite).where(eq(invite.id, id)).limit(1))[0];
    return still ? { ok: false, status: 429, message: RESEND_TOO_SOON } : { ok: false, status: 404, message: GONE };
  }
  try {
    const host = new URL(signUpUrl).host;
    await send(row.entry, `Your invitation to ${host}`, signUpUrl, `You have been invited to ${host}. To join, open this link and sign up with this email address (${row.entry}):`);
  } catch (e) {
    await db.update(invite).set({ lastSentAt: row.lastSentAt }).where(eq(invite.id, id)); // a mail that never went out frees the slot
    throw e;
  }
  const [, sent] = await db.batch([
    auditWhileInvite(st, id, auditRow({ actor, verb: "send-invite", target: { id: null, email: row.entry } })),
    db.update(invite).set({ lastSentAt: now }).where(eq(invite.id, id)).returning({ id: invite.id }),
  ]);
  if (!sent.length) return { ok: false, status: 404, message: GONE }; // revoked while the mail was going out: nothing is recorded
  return { ok: true, message: INVITE_EMAIL_REQUESTED(row.entry) };
}
