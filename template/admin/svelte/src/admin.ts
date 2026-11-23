import { HTTPException } from "hono/http-exception";
import { requireAuth } from "void/auth";
import { env } from "void/env";
import type { Verb } from "./lib/admin-display";
import { signupAllowed } from "./signup-allowlist";

export * from "./lib/admin-display";

// The admin module: who is an admin, the shape of an audit entry, and the read-only queries the admin pages use. Pages call these, never the
// tables. Every write goes through the Better Auth admin plugin (guarded and audited in admin-guard.ts) or a function here.

// Replaced by the --invite-only installer: an unverified user in an invite-only app gets a set-password link, not a reset link.
export const INVITE_ONLY = false;

export type Person = { email: string; emailVerified?: boolean | null };

// Admin = a verified email on ADMIN_EMAILS (the same matcher as the invite list). Checked live on every request; there is no promote button.
export const isAdmin = (list: unknown, user: Person | null | undefined): boolean => !!user && user.emailVerified === true && signupAllowed(list, user.email);

// For the Account page: a listed but unverified owner gets a hint; everyone else sees nothing.
export const adminAccess = (user: Person | null | undefined): "admin" | "unverified" | null =>
  !user ? null : isAdmin(env.ADMIN_EMAILS, user) ? "admin" : user.emailVerified !== true && signupAllowed(env.ADMIN_EMAILS, user.email) ? "unverified" : null;

export const notFound = () => new HTTPException(404, { message: "Not Found" });

// 404, not 401 or 403, for everyone who is not an admin: the admin area is not discoverable.
export function requireAdmin(c: Parameters<typeof requireAuth>[0]) {
  let user: ReturnType<typeof requireAuth>;
  try {
    user = requireAuth(c);
  } catch {
    throw notFound();
  }
  if (!isAdmin(env.ADMIN_EMAILS, user)) throw notFound();
  return user;
}

// A browser always sends Origin on a cross-site POST; a missing or foreign one is refused before anything runs (as Better Auth's own MISSING_OR_NULL_ORIGIN).
export function requireSameOrigin(c: { req: { header: (n: string) => string | undefined; url: string } }) {
  const origin = c.req.header("origin");
  if (!origin || origin !== new URL(c.req.url).origin) throw new HTTPException(403, { message: "Forbidden" });
}

export const setPasswordLink = (user: Person): boolean => INVITE_ONLY && user.emailVerified !== true;

// ---- audit -------------------------------------------------------------------------------------------------------------------------

export type AuditInput = {
  actor: { id: string; email: string };
  verb: Verb;
  target?: { id: string | null; email: string | null } | null;
  detail?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
};

// The one place an audit row's shape is decided; every writer calls it.
export const auditRow = (i: AuditInput, now: Date = new Date()) => ({
  id: crypto.randomUUID(),
  actorUserId: i.actor.id,
  actorEmail: i.actor.email.toLowerCase(),
  targetUserId: i.target?.id ?? null,
  targetEmail: i.target?.email?.toLowerCase() ?? null,
  verb: i.verb,
  detail: i.detail ?? null,
  oldValue: i.oldValue ?? null,
  newValue: i.newValue ?? null,
  createdAt: now,
});

// void/db and @schema are imported on use: Void's plugin loads auth.ts (and so this file) at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")), ...(await import("../.void/better-auth-schema")) });

export async function recordAudit(i: AuditInput): Promise<void> {
  const { db, auditEntry } = await store();
  await db.insert(auditEntry).values(auditRow(i));
}

// A deleted user's address (and any free text about them, such as a ban reason) leaves the audit log; the record that a change happened stays.
// Rows reference the user with "set null", so the ids are already gone by the time this runs: match on the email.
export async function redactAudit(email: string): Promise<void> {
  const { db, eq, and, auditEntry } = await store();
  const e = email.toLowerCase();
  // Only a ban reason is free text about the user; other details (a feature name, an invite kind) stay so the entry still reads.
  await db.batch([
    db.update(auditEntry).set({ detail: null }).where(and(eq(auditEntry.targetEmail, e), eq(auditEntry.verb, "ban"))),
    db.update(auditEntry).set({ targetEmail: null }).where(eq(auditEntry.targetEmail, e)),
    db.update(auditEntry).set({ actorEmail: null }).where(eq(auditEntry.actorEmail, e)),
  ]);
}

export const PAGE_SIZE = 50;

export async function listAudit(user: string, page: number) {
  const { db, desc, eq, count, auditEntry } = await store();
  const where = user ? eq(auditEntry.targetEmail, user.toLowerCase()) : undefined;
  const rows = await db.select().from(auditEntry).where(where).orderBy(desc(auditEntry.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  const [{ n }] = await db.select({ n: count() }).from(auditEntry).where(where);
  return { rows, total: n };
}

// ---- users (read-only; every write is the admin plugin's) --------------------------------------------------------------------------

export async function listUsers(q: string, page: number) {
  const { db, desc, sql, count, userTable } = await store();
  const needle = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = q ? sql`(${userTable.email} like ${needle} escape '\\' or ${userTable.name} like ${needle} escape '\\')` : undefined;
  const rows = await db.select().from(userTable).where(where).orderBy(desc(userTable.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  const [{ n }] = await db.select({ n: count() }).from(userTable).where(where);
  return { rows, total: n };
}

export const userExists = async (id: string): Promise<boolean> => (await findUser(id)) !== null;

export async function findUser(id: string) {
  const { db, eq, userTable } = await store();
  return (await db.select().from(userTable).where(eq(userTable.id, id)).limit(1))[0] ?? null;
}

// A user's live sessions, read here (not through the plugin's list-user-sessions) so the raw token stays on the server: pages get ids, and the revoke route maps id to token.
export async function listSessions(userId: string) {
  const { db, eq, desc, sessionTable } = await store();
  const rows = await db.select().from(sessionTable).where(eq(sessionTable.userId, userId)).orderBy(desc(sessionTable.createdAt));
  return rows.filter((s) => s.expiresAt > new Date());
}
