import { LISTS } from "./app/lists";
import { type ConsentState, type ListDecl, nextConsent } from "./lib/consent-core";
import { send } from "./mail";

// Consent for marketing mail: who asked for which list, and what they confirmed. Routes and pages call these named entry points, never the tables.
// Declare lists in src/app/lists.ts (this file never changes for that). The rules (next state, who may receive) are pure and live in src/lib/consent-core.ts.
//
// Invariant: every way of adding an address needs a confirmation from that inbox before any marketing mail goes to it. Marketing mail never goes through
// the sender in src/mail.ts: that one is for transactional mail, and the confirmation below is the only mail it sends here.
export { LISTS };

export const CHECK_INBOX = "Check your inbox to confirm";
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a confirmation link is good for seven days
export const RESEND_MS = 10 * 60 * 1000; // at most one confirmation mail per address in ten minutes, whichever list it is for
export const CEILING_PER_HOUR = 100; // and at most this many in an hour, app-wide
// What the Account page and the admin delete show when removing the subscriber fails: the deletion is refused.
export const SUBSCRIBER_REMOVAL_FAILED = {
  code: "SUBSCRIBER_REMOVAL_FAILED",
  message: "Couldn't remove the account's email subscriptions, so the account was not deleted. Try again.",
};

// void/db and @schema are imported on use: Void's plugin loads auth.ts (and so this file) at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")) });

export const findList = (name: unknown): ListDecl | undefined => (LISTS as readonly ListDecl[]).find((l) => l.name === name);
const wordingOf = (l: ListDecl) => `${l.label}: ${l.description}`;

export function normalizeEmail(raw: unknown): string | null {
  const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  // No markup, list separators or quotes: an address like that is not worth a mail.
  return e.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(e) ? e : null;
}
const tokenOf = (raw: unknown): string | null => (typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : null);
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

type Ask = { origin: string; page: string }; // the app's own origin (for the link) and the page the person was asked on

const logCeiling = () => console.warn(`marketing: the hourly ceiling of ${CEILING_PER_HOUR} confirmation mails is reached; a request was not mailed`);
const hourOf = (d: Date) => Math.floor(d.getTime() / (60 * 60 * 1000));

// The one way a confirmation mail is requested. Claim-then-mail-then-free, as the invites module does. Three claims, each one conditional write, taken in this order:
// the address's ten-minute slot (subscriber.last_mail_at), then a slot under the app-wide hourly ceiling (mail_ceiling, a counter per clock hour), then the consent row.
// A claim that fails gives back the ones before it and sends nothing, so two requests at once mail once and the ceiling counts real sends; a mail that fails gives all of them back.
async function request(email: string, list: ListDecl, ask: Ask): Promise<void> {
  const { db, eq, and, or, ne, isNull, lt, sql, subscriber, consent, mailCeiling } = await store();
  const now = new Date();
  const since = new Date(now.getTime() - RESEND_MS);
  const hour = hourOf(now);
  // The row is made first because the address's slot lives on it and two first-time requests must meet at one row (the insert is one conditional write: the loser's does
  // nothing). An address is not kept unless it is mailed: whichever request made the row takes it away again, in one conditional delete, when no mail goes out.
  const created = (await db.insert(subscriber).values({ id: crypto.randomUUID(), email, unsubscribeToken: randomToken(), createdAt: now, lastMailAt: null }).onConflictDoNothing().returning({ id: subscriber.id })).length === 1;
  const sub = (await db.select().from(subscriber).where(eq(subscriber.email, email)).limit(1))[0]!;
  const row = (await db.select().from(consent).where(and(eq(consent.subscriberId, sub.id), eq(consent.list, list.name))).limit(1))[0];
  const sent = (await db.select({ sent: mailCeiling.sent }).from(mailCeiling).where(eq(mailCeiling.hour, hour)).limit(1))[0]?.sent ?? 0;
  const mailedRecently = !!sub.lastMailAt && sub.lastMailAt > since;
  // Only a row this request made, still unmailed and with no consent, goes: one that has a mail slot taken or any consent is never deleted here.
  const dropIfUnused = async () => {
    if (created) await db.delete(subscriber).where(and(eq(subscriber.id, sub.id), isNull(subscriber.lastMailAt), sql`not exists (select 1 from consent where subscriber_id = ${sub.id})`));
  };
  const next = nextConsent((row?.state as ConsentState | undefined) ?? null, { kind: "request" }, { mailedRecently, ceilingHit: sent >= CEILING_PER_HOUR });
  if (!next.mail) {
    if (sent >= CEILING_PER_HOUR && !mailedRecently && row?.state !== "confirmed") logCeiling();
    await dropIfUnused();
    return;
  }
  // 1. The address's slot: one mail per address per ten minutes, whichever list it is for.
  const slot = await db
    .update(subscriber)
    .set({ lastMailAt: now })
    .where(and(eq(subscriber.id, sub.id), or(isNull(subscriber.lastMailAt), lt(subscriber.lastMailAt, since))))
    .returning({ id: subscriber.id });
  if (!slot.length) return await dropIfUnused();
  const freeSlot = () => db.update(subscriber).set({ lastMailAt: sub.lastMailAt }).where(and(eq(subscriber.id, sub.id), eq(subscriber.lastMailAt, now)));
  // 2. A slot under the hourly ceiling: the counter row is created at 1 or raised by 1, and only while it is under the ceiling.
  const ceiling = await db
    .insert(mailCeiling)
    .values({ hour, sent: 1 })
    .onConflictDoUpdate({ target: mailCeiling.hour, set: { sent: sql`${mailCeiling.sent} + 1` }, setWhere: lt(mailCeiling.sent, CEILING_PER_HOUR) })
    .returning({ hour: mailCeiling.hour });
  if (!ceiling.length) {
    logCeiling();
    await freeSlot();
    return await dropIfUnused();
  }
  const freeCeiling = () => db.update(mailCeiling).set({ sent: sql`${mailCeiling.sent} - 1` }).where(and(eq(mailCeiling.hour, hour), sql`${mailCeiling.sent} > 0`));
  // 3. The consent row.
  const token = randomToken();
  const fresh = { state: "pending", source: "form", page: ask.page, wording: wordingOf(list), requestedAt: now, confirmedAt: null, withdrawnAt: null, withdrawnHow: null, confirmToken: token };
  const claimed = row
    ? await db
        .update(consent)
        .set(fresh)
        .where(and(eq(consent.subscriberId, sub.id), eq(consent.list, list.name), ne(consent.state, "confirmed")))
        .returning({ id: consent.subscriberId })
    : await db.insert(consent).values({ subscriberId: sub.id, list: list.name, ...fresh }).onConflictDoNothing().returning({ id: consent.subscriberId });
  if (!claimed.length) {
    await freeCeiling(); // confirmed meanwhile, or another request wrote the row first
    await freeSlot();
    return await dropIfUnused();
  }
  try {
    await send(email, "Confirm your subscription", `${ask.origin}/confirm?token=${token}`, `Confirm that you want ${list.label} (${list.description}) at this address. Open this link, then press Confirm:`);
  } catch (e) {
    const mine = and(eq(consent.subscriberId, sub.id), eq(consent.list, list.name), eq(consent.confirmToken, token));
    try {
      if (row) {
        // a mail that never went out frees every slot and puts the row back
        const { state, source, page, wording, requestedAt, confirmedAt, withdrawnAt, withdrawnHow, confirmToken } = row;
        await db.update(consent).set({ state, source, page, wording, requestedAt, confirmedAt, withdrawnAt, withdrawnHow, confirmToken }).where(mine);
      } else await db.delete(consent).where(mine);
      await freeCeiling();
      await freeSlot();
      await dropIfUnused();
    } catch (undoError) {
      // the send error is the one the caller needs; the failed undo is logged beside it, never in its place
      console.error("marketing: could not give back a confirmation mail's slots after the send failed", undoError instanceof Error ? undoError.message : "unknown error");
    }
    throw e;
  }
}

// What a route checks before it answers, so the answer does not wait for the work: the address and the list, or why they are refused.
export function parseJoin(rawEmail: unknown, listName: unknown): { email: string; list: ListDecl } | "bad-email" | "bad-list" {
  const email = normalizeEmail(rawEmail);
  const list = findList(listName);
  return !email ? "bad-email" : !list ? "bad-list" : { email, list };
}

// The subscribe form. Returns nothing that depends on the address (a refused address or list is a refusal of the input, not of who is subscribed).
export async function requestJoin(rawEmail: unknown, listName: unknown, ask: Ask): Promise<"ok" | "bad-email" | "bad-list"> {
  const email = normalizeEmail(rawEmail);
  const list = findList(listName);
  if (!email) return "bad-email";
  if (!list) return "bad-list";
  await request(email, list, ask);
  return "ok";
}

// "Subscribe again" on the unsubscribe page: a new request, found by the unsubscribe token, mailing a confirmation. It confirms nothing by itself:
// the token sits in every mail, so a forwarded copy must not be able to re-subscribe someone. An unknown token answers "ok" and does nothing.
export async function requestAgain(rawToken: unknown, listName: unknown, ask: Ask): Promise<"ok" | "bad-list"> {
  const list = findList(listName);
  if (!list) return "bad-list";
  const t = tokenOf(rawToken);
  if (!t) return "ok";
  const { db, eq, subscriber } = await store();
  const sub = (await db.select({ email: subscriber.email }).from(subscriber).where(eq(subscriber.unsubscribeToken, t)).limit(1))[0];
  if (sub) await request(sub.email, list, ask);
  return "ok";
}

export type Confirmation = { status: "ready" | "confirmed" | "expired" | "unknown"; list?: ListDecl };

// What the confirm page shows. A read: it changes nothing, so a mail scanner opening the link does no harm.
export async function readConfirmation(rawToken: unknown): Promise<Confirmation> {
  const t = tokenOf(rawToken);
  if (!t) return { status: "unknown" };
  const { db, eq, consent } = await store();
  const row = (await db.select().from(consent).where(eq(consent.confirmToken, t)).limit(1))[0];
  const list = row && findList(row.list);
  if (!row || !list || (row.state !== "pending" && row.state !== "confirmed")) return { status: "unknown" };
  if (row.state === "confirmed") return { status: "confirmed", list };
  return { status: Date.now() - row.requestedAt.getTime() < CONFIRM_TTL_MS ? "ready" : "expired", list };
}

// The Confirm button's POST: the only way a mailed link records consent.
export async function confirm(rawToken: unknown): Promise<Confirmation> {
  const read = await readConfirmation(rawToken);
  const t = tokenOf(rawToken);
  if (!t || read.status === "confirmed" || read.status === "unknown") return read;
  const next = nextConsent("pending", { kind: "confirm-press", tokenValid: read.status === "ready" });
  if (next.state !== "confirmed") return read;
  const { db, eq, and, gt, consent } = await store();
  const done = await db
    .update(consent)
    .set({ state: "confirmed", confirmedAt: new Date() })
    .where(and(eq(consent.confirmToken, t), eq(consent.state, "pending"), gt(consent.requestedAt, new Date(Date.now() - CONFIRM_TTL_MS))))
    .returning({ id: consent.subscriberId });
  return done.length ? { status: "confirmed", list: read.list } : readConfirmation(t);
}

// Takes effect at once, needs no sign-in, and is repeatable. An unknown token does nothing (and the route answers the same). The confirmation token is cleared, so a
// link mailed before the withdrawal cannot confirm again.
export async function unsubscribe(rawToken: unknown, scope: { list: string } | "all", how: "link" | "one-click"): Promise<void> {
  const t = tokenOf(rawToken);
  if (!t) return;
  const { db, eq, and, ne, subscriber, consent } = await store();
  const sub = (await db.select({ id: subscriber.id }).from(subscriber).where(eq(subscriber.unsubscribeToken, t)).limit(1))[0];
  if (!sub) return;
  await db
    .update(consent)
    .set({ state: "unsubscribed", withdrawnAt: new Date(), withdrawnHow: how, confirmToken: null })
    .where(and(eq(consent.subscriberId, sub.id), ne(consent.state, "unsubscribed"), scope === "all" ? undefined : eq(consent.list, scope.list)));
}

// Account deletion, by the user and by an admin: the subscriber and its consent go first, and a failure throws so the caller refuses the deletion.
// No record is kept afterwards: the invariant above is what makes that safe (the same address subscribing again is pending until confirmed).
export async function removeSubscriber(email: string): Promise<void> {
  const { db, eq, inArray, subscriber, consent } = await store();
  const e = email.trim().toLowerCase();
  await db.batch([
    db.delete(consent).where(inArray(consent.subscriberId, db.select({ id: subscriber.id }).from(subscriber).where(eq(subscriber.email, e)))),
    db.delete(subscriber).where(eq(subscriber.email, e)),
  ]);
}
