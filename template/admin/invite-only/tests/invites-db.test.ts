import { beforeEach, expect, it, vi } from "vite-plus/test";

// The invite functions' real queries, on an in-memory SQLite behind the same drizzle calls. void/db (and the mail sender) are the only stand-ins.
// D1 runs a batch as one transaction; the stand-in does the same, so a race between requests resolves the way it does in production.
const mail = vi.hoisted(() => ({ send: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("void/env", () => ({ env: { SIGNUP_ALLOWLIST: "listed@example.com" } }));
vi.mock("void/auth", () => ({ requireAuth: () => null }));
vi.mock("../src/mail", () => mail);
vi.mock("void/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const orm = await import("drizzle-orm");
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    create table audit_entry (id text primary key, actor_user_id text, actor_email text, target_user_id text, target_email text, verb text not null, detail text, old_value text, new_value text, created_at integer not null);
    create table invite (id text primary key, entry text not null unique, added_by_user_id text, created_at integer not null, last_sent_at integer);`);
  const db = drizzle(sqlite);
  const exec = (q: { all(): unknown; run(): unknown }) => {
    try {
      return q.all();
    } catch (e) {
      if (/does not return data/.test(String(e))) return q.run();
      throw e;
    }
  };
  return { db: Object.assign(db, { batch: async (qs: never[]) => sqlite.transaction(() => qs.map(exec))() }), sqlite, ...orm };
});
vi.mock("@schema", async () => ({ ...(await import("../db/schema/admin")), ...(await import("../db/schema/invites")) }));

const { addInvite, revokeInvite, sendInvite, STILL_INVITED_DOMAIN, RESEND_TOO_SOON } = await import("../src/invites");
const { sqlite, db } = (await import("void/db")) as unknown as { sqlite: import("better-sqlite3").Database; db: { update: (...a: never[]) => unknown } };

const actor = { id: "a1", email: "boss@example.com" };
const audit = (verb: string) => sqlite.prepare("select * from audit_entry where verb = ?").all(verb);
const idOf = (entry: string) => (sqlite.prepare("select id from invite where entry = ?").get(entry) as { id: string }).id;

beforeEach(() => {
  sqlite.exec("delete from audit_entry; delete from invite");
  mail.send.mockClear();
});

it("four concurrent revokes of one invite: one wins and writes one entry, the rest are 404 and write nothing", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  const out = await Promise.all([1, 2, 3, 4].map(() => revokeInvite(actor, id)));
  expect(out.filter((o) => o.ok)).toHaveLength(1);
  expect(out.filter((o) => !o.ok && o.status === 404)).toHaveLength(3);
  expect(audit("revoke-invite")).toHaveLength(1);
});

it("a send that races a revoke is 404 and writes no send-invite entry", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  mail.send.mockImplementationOnce(async () => void (await revokeInvite(actor, id)));
  const out = await sendInvite(actor, id, "http://localhost/sign-up");
  expect(out).toMatchObject({ ok: false, status: 404 });
  expect(audit("send-invite")).toHaveLength(0);
  expect(audit("revoke-invite")).toHaveLength(1);
});

it("a resend within 60 seconds is 429 and mails nothing; after a minute it goes out", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  expect(await sendInvite(actor, id, "http://localhost/sign-up")).toMatchObject({ ok: true });
  expect(await sendInvite(actor, id, "http://localhost/sign-up")).toEqual({ ok: false, status: 429, message: RESEND_TOO_SOON });
  expect(RESEND_TOO_SOON).toBe("An invite was just sent. Try again in a minute.");
  expect(mail.send).toHaveBeenCalledTimes(1);
  expect(audit("send-invite")).toHaveLength(1);
  sqlite.prepare("update invite set last_sent_at = ? where id = ?").run(Date.now() - 61_000, id);
  expect(await sendInvite(actor, id, "http://localhost/sign-up")).toMatchObject({ ok: true });
  expect(audit("send-invite")).toHaveLength(2);
});

it("four concurrent adds of one entry: one wins, the rest are 409 (not an error), one audit entry", async () => {
  const out = await Promise.all([1, 2, 3, 4].map(() => addInvite(actor, "email", "x@tester.test")));
  expect(out.filter((o) => o.ok)).toHaveLength(1);
  expect(out.filter((o) => !o.ok && o.status === 409)).toHaveLength(3);
  expect(audit("invite")).toHaveLength(1);
});

it("revoking an exact email says when a remaining domain invite still admits it, besides the secret note", async () => {
  await addInvite(actor, "domain", "tester.test");
  await addInvite(actor, "email", "x@tester.test");
  const out = await revokeInvite(actor, idOf("x@tester.test"));
  expect(out).toMatchObject({ ok: true });
  if (out.ok) expect(out.notes[0]).toBe(STILL_INVITED_DOMAIN("@tester.test"));
  await addInvite(actor, "email", "listed@example.com");
  const covered = await revokeInvite(actor, idOf("listed@example.com"));
  if (covered.ok) expect(covered.notes[0]).toBe("Still invited through SIGNUP_ALLOWLIST.");
  const plain = await (async () => { await addInvite(actor, "email", "y@other.test"); return revokeInvite(actor, idOf("y@other.test")); })();
  if (plain.ok) expect(plain.notes).toEqual(["Existing accounts are not affected. Ban the user to block them."]);
});

const lastSent = (id: string) => (sqlite.prepare("select last_sent_at from invite where id = ?").get(id) as { last_sent_at: number | null }).last_sent_at;

it("four concurrent sends of one invite: one 200, three 429, one send-invite entry", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  const out = await Promise.all([1, 2, 3, 4].map(() => sendInvite(actor, id, "http://localhost/sign-up")));
  expect(out.filter((o) => o.ok)).toHaveLength(1);
  expect(out.filter((o) => !o.ok && o.status === 429)).toHaveLength(3);
  expect(audit("send-invite")).toHaveLength(1);
});

it("a send that throws restores last_sent_at to null and writes no entry", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(sendInvite(actor, id, "http://localhost/sign-up")).rejects.toThrow("mail down");
  expect(lastSent(id)).toBeNull();
  expect(audit("send-invite")).toHaveLength(0);
});

it("a resend that throws restores the earlier time", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  const earlier = Date.now() - 61_000;
  sqlite.prepare("update invite set last_sent_at = ? where id = ?").run(earlier, id);
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(sendInvite(actor, id, "http://localhost/sign-up")).rejects.toThrow("mail down");
  expect(lastSent(id)).toBe(earlier);
  expect(audit("send-invite")).toHaveLength(0);
});

it("a send whose invite is deleted between the read and the claim is 404, not 429", async () => {
  await addInvite(actor, "email", "x@tester.test");
  const id = idOf("x@tester.test");
  const real = db.update.bind(db);
  const spy = vi.spyOn(db, "update").mockImplementationOnce((...a) => {
    sqlite.prepare("delete from invite where id = ?").run(id);
    return real(...a);
  });
  expect(await sendInvite(actor, id, "http://localhost/sign-up")).toMatchObject({ ok: false, status: 404 });
  spy.mockRestore();
  expect(mail.send).not.toHaveBeenCalled();
});
