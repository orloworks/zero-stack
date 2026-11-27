import { beforeEach, expect, it, vi } from "vite-plus/test";

// The consent module's real queries, on an in-memory SQLite behind the same drizzle calls. void/db (and the mail sender) are the only stand-ins.
// D1 runs a batch as one transaction; the stand-in does the same, so a removal that fails half way leaves both tables as they were.
const mail = vi.hoisted(() => ({ send: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("../src/mail", () => mail);
vi.mock("void/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const orm = await import("drizzle-orm");
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    create table subscriber (id text primary key, email text not null unique, unsubscribe_token text not null unique, created_at integer not null);
    create table consent (subscriber_id text not null references subscriber(id) on delete cascade, list text not null, state text not null, source text not null, page text not null, wording text not null, requested_at integer not null, confirmed_at integer, withdrawn_at integer, withdrawn_how text, confirm_token text unique, last_mail_at integer, primary key (subscriber_id, list));`);
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
vi.mock("@schema", async () => await import("../db/schema/marketing"));

const { CEILING_PER_HOUR, LISTS, CONFIRM_TTL_MS, confirm, readConfirmation, removeSubscriber, requestAgain, requestJoin, RESEND_MS, unsubscribe } = await import("../src/consent");
const { removeSubscriberOrRefuse } = await import("../src/subscriber-removal");
const { sqlite } = (await import("void/db")) as unknown as { sqlite: import("better-sqlite3").Database };

// The first declared list, whatever the app has renamed it to.
const DECL = LISTS[0]!;
const LIST = DECL.name;
const ASK = { origin: "http://app.test", page: "/subscribe" };
const ANN = "ann@example.com";
const rows = (sql: string, ...a: unknown[]) => sqlite.prepare(sql).all(...a) as Record<string, unknown>[];
const consentOf = (email: string) => rows("select c.* from consent c join subscriber s on s.id = c.subscriber_id where s.email = ?", email)[0];
const tokenOf = (email: string) => (rows("select unsubscribe_token t from subscriber where email = ?", email)[0] as { t: string }).t;
const linkToken = (n = -1) => new URL(String(mail.send.mock.calls.at(n)![2])).searchParams.get("token")!;
const everything = () => JSON.stringify([rows("select * from subscriber order by email"), rows("select * from consent order by confirm_token")]);
const age = (email: string, ms: number) => sqlite.prepare("update consent set last_mail_at = last_mail_at - ?, requested_at = requested_at - ? where subscriber_id = (select id from subscriber where email = ?)").run(ms, ms, email);

beforeEach(() => {
  sqlite.exec("delete from consent; delete from subscriber; drop trigger if exists no_delete");
  mail.send.mockReset();
  mail.send.mockImplementation(async () => {});
});

it("a new address is pending with one plain mail naming the list and a link that opens the confirm page", async () => {
  expect(await requestJoin(" Ann@Example.com ", LIST, ASK)).toBe("ok");
  expect(mail.send).toHaveBeenCalledTimes(1);
  const [to, subject, url, intro] = mail.send.mock.calls[0]!;
  expect([to, subject]).toEqual([ANN, "Confirm your subscription"]);
  expect(String(url)).toMatch(/^http:\/\/app\.test\/confirm\?token=[\w-]{43}$/);
  expect(String(intro)).toContain(DECL.label);
  expect(consentOf(ANN)).toMatchObject({ list: LIST, state: "pending", source: "form", page: "/subscribe", wording: `${DECL.label}: ${DECL.description}`, confirmed_at: null });
});

it("a double submit mails once", async () => {
  await Promise.all([requestJoin(ANN, LIST, ASK), requestJoin(ANN, LIST, ASK)]);
  expect(mail.send).toHaveBeenCalledTimes(1);
  expect(rows("select * from consent")).toHaveLength(1);
  await requestJoin(ANN, LIST, ASK); // and again inside ten minutes
  expect(mail.send).toHaveBeenCalledTimes(1);
});

it("a failed mail frees the throttle slot: a new address leaves no row, a known one gets its old row back, and the next request mails", async () => {
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  expect(rows("select * from consent")).toHaveLength(0);
  await requestJoin(ANN, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(2);
  await unsubscribe(tokenOf(ANN), "all", "link");
  age(ANN, RESEND_MS + 1000);
  const before = consentOf(ANN);
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  expect(consentOf(ANN)).toEqual(before);
  await requestJoin(ANN, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(4);
});

it("a second request inside ten minutes mails nothing; after ten minutes it mails again with a new link", async () => {
  await requestJoin(ANN, LIST, ASK);
  const first = linkToken();
  await requestJoin(ANN, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(1);
  age(ANN, RESEND_MS + 1000);
  await requestJoin(ANN, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(linkToken()).not.toBe(first);
  expect((await readConfirmation(first)).status).toBe("unknown"); // the old link was replaced
});

it("the hourly ceiling stops further mail and is logged when hit", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const now = Date.now();
  sqlite.prepare("insert into subscriber values ('s0', 'x@example.com', 't0', ?)").run(now);
  for (let i = 0; i < CEILING_PER_HOUR; i++) sqlite.prepare("insert into consent values ('s0', ?, 'pending', 'form', '/', 'w', ?, null, null, null, ?, ?)").run(`l${i}`, now, `c${i}`, now);
  await requestJoin("new@example.com", LIST, ASK);
  expect(mail.send).not.toHaveBeenCalled();
  expect(rows("select * from subscriber where email = 'new@example.com'")).toHaveLength(0);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("hourly ceiling"));
  warn.mockRestore();
});

it("a request for a confirmed address changes and mails nothing", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  age(ANN, RESEND_MS + 1000);
  const before = everything();
  await requestJoin(ANN, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(1);
  expect(everything()).toBe(before);
});

it("an unknown list and a malformed address are refused without a mail or a row", async () => {
  expect(await requestJoin(ANN, "nope", ASK)).toBe("bad-list");
  for (const bad of ["", "no-at", "a@b", 42, null]) expect(await requestJoin(bad, LIST, ASK)).toBe("bad-email");
  expect(mail.send).not.toHaveBeenCalled();
  expect(rows("select * from subscriber")).toHaveLength(0);
});

it("reads never write: the confirm page's read leaves every row as it was, for a ready, an expired and an unknown link", async () => {
  await requestJoin(ANN, LIST, ASK);
  const token = linkToken();
  const before = everything();
  expect(await readConfirmation(token)).toMatchObject({ status: "ready", list: { name: LIST } });
  expect(await readConfirmation("unknown-token")).toEqual({ status: "unknown" });
  expect(await readConfirmation(undefined)).toEqual({ status: "unknown" });
  expect(everything()).toBe(before);
  age(ANN, CONFIRM_TTL_MS + 1000);
  const aged = everything();
  expect((await readConfirmation(token)).status).toBe("expired");
  expect(everything()).toBe(aged);
});

it("the Confirm press confirms once; an expired and an unknown link do not; a second press says confirmed", async () => {
  await requestJoin(ANN, LIST, ASK);
  const token = linkToken();
  age(ANN, CONFIRM_TTL_MS + 1000);
  expect((await confirm(token)).status).toBe("expired");
  expect(consentOf(ANN)).toMatchObject({ state: "pending", confirmed_at: null });
  expect((await confirm("nope")).status).toBe("unknown");
  age(ANN, -(CONFIRM_TTL_MS + 1000));
  expect((await confirm(token)).status).toBe("confirmed");
  expect(consentOf(ANN)).toMatchObject({ state: "confirmed" });
  expect(consentOf(ANN)!.confirmed_at).toBeGreaterThan(0);
  expect((await confirm(token)).status).toBe("confirmed");
});

it("unsubscribe from this list or everything takes effect at once, is repeatable, clears the confirm link, and an unknown token does nothing", async () => {
  await requestJoin(ANN, LIST, ASK);
  const link = linkToken();
  await confirm(link);
  sqlite.prepare("insert into consent select subscriber_id, 'other', 'confirmed', source, page, wording, requested_at, confirmed_at, null, null, 'tok-other', null from consent").run();
  const unsub = tokenOf(ANN);
  await unsubscribe(unsub, { list: LIST }, "one-click");
  expect(rows("select list, state, withdrawn_how from consent order by list")).toEqual([
    { list: LIST, state: "unsubscribed", withdrawn_how: "one-click" },
    { list: "other", state: "confirmed", withdrawn_how: null },
  ]);
  await unsubscribe(unsub, { list: LIST }, "link"); // repeatable, and the first withdrawal stands
  expect(rows("select withdrawn_how from consent where list = ?", LIST)).toEqual([{ withdrawn_how: "one-click" }]);
  await unsubscribe(unsub, "all", "link");
  expect(rows("select state from consent").map((r) => r.state)).toEqual(["unsubscribed", "unsubscribed"]);
  expect((await confirm(link)).status).toBe("unknown"); // a link mailed before the withdrawal cannot confirm again
  const before = everything();
  await unsubscribe("unknown-token", "all", "link");
  await unsubscribe(undefined, "all", "link");
  expect(everything()).toBe(before);
});

it("Subscribe again mails a confirmation and confirms nothing by itself", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  await unsubscribe(tokenOf(ANN), { list: LIST }, "link");
  age(ANN, RESEND_MS + 1000);
  expect(await requestAgain(tokenOf(ANN), LIST, { ...ASK, page: "/unsubscribe" })).toBe("ok");
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(consentOf(ANN)).toMatchObject({ state: "pending", page: "/unsubscribe", withdrawn_at: null, confirmed_at: null });
  expect(await requestAgain("unknown-token", LIST, ASK)).toBe("ok");
  expect(await requestAgain(tokenOf(ANN), "nope", ASK)).toBe("bad-list");
  expect(mail.send).toHaveBeenCalledTimes(2);
});

it("removal clears both tables, and throws, leaving both as they were, when the database fails", async () => {
  await requestJoin(ANN, LIST, ASK);
  await requestJoin("bob@example.com", LIST, ASK);
  sqlite.exec("create trigger no_delete before delete on subscriber begin select raise(abort, 'disk on fire'); end");
  const before = everything();
  await expect(removeSubscriber(ANN)).rejects.toThrow();
  expect(everything()).toBe(before);
  sqlite.exec("drop trigger no_delete");
  await removeSubscriber(" ANN@example.com ");
  expect(rows("select email from subscriber")).toEqual([{ email: "bob@example.com" }]);
  expect(rows("select * from consent")).toHaveLength(1);
  await removeSubscriber("nobody@example.com"); // no row: not an error
  // the same address subscribing again is pending until confirmed
  await requestJoin(ANN, LIST, ASK);
  expect(consentOf(ANN)).toMatchObject({ state: "pending" });
});

it("the deletion hooks' removal refuses with its own code and message when removing fails", async () => {
  await requestJoin(ANN, LIST, ASK);
  sqlite.exec("create trigger no_delete before delete on subscriber begin select raise(abort, 'disk on fire'); end");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const refused = await removeSubscriberOrRefuse({ id: "u1", email: ANN }).then(() => null, (e) => e as { statusCode: number; body: { code: string; message: string } });
  error.mockRestore();
  expect(refused?.statusCode).toBe(500);
  expect(refused?.body).toEqual({ code: "SUBSCRIBER_REMOVAL_FAILED", message: "Couldn't remove the account's email subscriptions, so the account was not deleted. Try again." });
  expect(rows("select * from subscriber")).toHaveLength(1);
  sqlite.exec("drop trigger no_delete");
  await removeSubscriberOrRefuse({ id: "u1", email: ANN });
  expect(rows("select * from subscriber")).toHaveLength(0);
});
