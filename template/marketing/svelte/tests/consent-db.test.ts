import { beforeEach, expect, it, vi } from "vite-plus/test";

// The consent module's real queries, on an in-memory SQLite behind the same drizzle calls. void/db (and the mail sender) are the only stand-ins.
// D1 runs a batch as one transaction; the stand-in does the same, so a removal that fails half way leaves both tables as they were.
const mail = vi.hoisted(() => ({ send: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("../src/mail", () => mail);
// Two lists, so the per-address throttle can be tested; the app's own file is checked by the declarations test.
vi.mock("../src/app/lists", () => ({ LISTS: [{ name: "first", label: "First list", description: "The first." }, { name: "second", label: "Second list", description: "The second." }] }));
vi.mock("void/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const orm = await import("drizzle-orm");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON"); // D1 enforces foreign keys; without this the stand-in hides a consent insert for a deleted subscriber
  sqlite.exec(`
    create table subscriber (id text primary key, email text not null unique, unsubscribe_token text not null unique, created_at integer not null, last_mail_at integer);
    create table mail_ceiling (hour integer primary key, sent integer not null);
    create table consent (subscriber_id text not null references subscriber(id) on delete cascade, list text not null, state text not null, source text not null, page text not null, wording text not null, requested_at integer not null, confirmed_at integer, withdrawn_at integer, withdrawn_how text, confirm_token text unique, primary key (subscriber_id, list));`);
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
vi.mock("void", () => ({ defineHandler: (h: unknown) => h })); // the route file only wraps its handler
vi.mock("@schema", async () => await import("../db/schema/marketing"));

const { CEILING_PER_HOUR, LISTS, CONFIRM_TTL_MS, confirm, readConfirmation, removeSubscriber, requestAgain, requestJoin, RESEND_MS, unsubscribe } = await import("../src/consent");
const { POST: unsubscribeRoute } = (await import("../routes/api/lists/unsubscribe")) as unknown as { POST: (c: never) => Promise<Response> };
const { Hono } = await import("hono");
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
// Moves the address's times back: its last confirmation mail (the throttle) and its consent requests (the seven-day expiry).
const age = (email: string, ms: number) => {
  sqlite.prepare("update subscriber set last_mail_at = last_mail_at - ? where email = ?").run(ms, email);
  sqlite.prepare("update consent set requested_at = requested_at - ? where subscriber_id = (select id from subscriber where email = ?)").run(ms, email);
};

beforeEach(() => {
  sqlite.exec("delete from consent; delete from subscriber; delete from mail_ceiling; drop trigger if exists no_delete; drop trigger if exists no_restore; drop trigger if exists race_insert; drop trigger if exists race_ceiling");
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
  expect(rows("select * from subscriber")).toHaveLength(1); // two first-time submits meet at one row
  await requestJoin(ANN, LIST, ASK); // and again inside ten minutes
  expect(mail.send).toHaveBeenCalledTimes(1);
});

it("a failed mail frees the throttle slot: a new address leaves no row, a known one gets its old row back, and the next request mails", async () => {
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  expect(rows("select * from consent")).toHaveLength(0);
  expect(rows("select * from subscriber")).toHaveLength(0); // a failed send for a brand-new address keeps no address either
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

it("the hourly ceiling counts real sends: 100 mails to a few addresses, then no more, and the hit is logged", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const addresses = ["a@example.com", "b@example.com", "c@example.com"];
  for (let i = 0; i < CEILING_PER_HOUR; i++) {
    const to = addresses[i % 3]!;
    await requestJoin(to, LIST, ASK);
    age(to, RESEND_MS + 1000); // the ten minutes pass, the hour does not
  }
  expect(mail.send).toHaveBeenCalledTimes(CEILING_PER_HOUR);
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: CEILING_PER_HOUR }]);
  await requestJoin("new@example.com", LIST, ASK);
  await requestJoin(addresses[0]!, LIST, ASK);
  expect(mail.send).toHaveBeenCalledTimes(CEILING_PER_HOUR);
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: CEILING_PER_HOUR }]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("hourly ceiling"));
  expect(consentOf("new@example.com")).toBeUndefined(); // no mail, no pending row
  expect(rows("select * from subscriber where email = 'new@example.com'")).toHaveLength(0); // an address that is not mailed is not kept
  expect(rows("select email from subscriber order by email")).toEqual(addresses.map((email) => ({ email }))); // and the ones already mailed (with consent) stay
  warn.mockRestore();
});

it("no path without a mail keeps a new address, and none deletes a known one: a confirmed address asking again, an address inside its ten minutes, a ceiling refusal", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  const known = everything();
  await requestJoin(ANN, LIST, ASK); // confirmed: no mail
  expect(everything()).toBe(known);
  const BOB = "bob@example.com";
  await requestJoin(BOB, LIST, ASK);
  await requestJoin(BOB, LIST, ASK); // inside ten minutes: no mail
  expect(rows("select email from subscriber order by email")).toEqual([{ email: ANN }, { email: BOB }]);
  sqlite.prepare("update mail_ceiling set sent = ?").run(CEILING_PER_HOUR); // the two mails above made this hour's row
  const before = everything();
  for (const to of [ANN, BOB]) await requestJoin(to, LIST, ASK); // known addresses under a used-up ceiling
  expect(everything()).toBe(before);
  await requestJoin("late@example.com", LIST, ASK);
  expect(rows("select * from subscriber where email = 'late@example.com'")).toHaveLength(0);
});

it("a failed send for an existing subscriber never deletes it, and a failed undo does not replace the send error", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  await unsubscribe(tokenOf(ANN), "all", "link");
  age(ANN, RESEND_MS + 1000);
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  expect(rows("select * from subscriber")).toHaveLength(1);
  expect(consentOf(ANN)).toMatchObject({ state: "unsubscribed" });
  // the undo itself fails (the database refuses the update): the caller still gets the send error, and the failed undo is logged
  age(ANN, RESEND_MS + 1000);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mail.send.mockImplementationOnce(async () => {
    // the claim went through; now break the undo, then fail the send
    sqlite.exec("create trigger no_restore before update on consent begin select raise(abort, 'disk on fire'); end");
    throw new Error("mail down");
  });
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  sqlite.exec("drop trigger if exists no_restore");
  expect(error).toHaveBeenCalledWith(expect.stringContaining("could not give back"), expect.stringContaining("disk on fire"));
  error.mockRestore();
});

it("a failed send gives the hourly slot back, along with the address's slot", async () => {
  await requestJoin(ANN, LIST, ASK);
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: 1 }]);
  age(ANN, RESEND_MS + 1000);
  mail.send.mockRejectedValueOnce(new Error("mail down"));
  await expect(requestJoin(ANN, LIST, ASK)).rejects.toThrow("mail down");
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: 1 }]);
  await requestJoin(ANN, LIST, ASK); // the slot is free again
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: 2 }]);
});

it("the ten-minute throttle is per address: the same address asking for two lists gets one mail", async () => {
  const [one, two] = LISTS.map((l) => l.name);
  expect(two).toBeDefined();
  await requestJoin(ANN, one, ASK);
  await requestJoin(ANN, two, ASK);
  expect(mail.send).toHaveBeenCalledTimes(1);
  expect(rows("select list from consent")).toEqual([{ list: one }]); // the refused request wrote nothing
  age(ANN, RESEND_MS + 1000);
  await requestJoin(ANN, two, ASK);
  expect(mail.send).toHaveBeenCalledTimes(2);
  expect(rows("select list from consent order by list").length).toBe(2);
});

it("addresses with markup, separators or quotes are refused", async () => {
  for (const bad of ["a<b>@example.com", "a@exa>mple.com", "a,b@example.com", "a@example.com,b@example.com", "a;b@example.com", 'a"b@example.com']) expect(await requestJoin(bad, LIST, ASK)).toBe("bad-email");
  expect(mail.send).not.toHaveBeenCalled();
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
  sqlite.prepare("insert into consent select subscriber_id, 'other', 'confirmed', source, page, wording, requested_at, confirmed_at, null, null, 'tok-other' from consent").run();
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
  const refused = await removeSubscriberOrRefuse({ id: "u1", email: ANN, emailVerified: true }).then(() => null, (e) => e as { statusCode: number; body: { code: string; message: string } });
  error.mockRestore();
  expect(refused?.statusCode).toBe(500);
  expect(refused?.body).toEqual({ code: "SUBSCRIBER_REMOVAL_FAILED", message: "Couldn't remove the account's email subscriptions, so the account was not deleted. Try again." });
  expect(rows("select * from subscriber")).toHaveLength(1);
  sqlite.exec("drop trigger no_delete");
  await removeSubscriberOrRefuse({ id: "u1", email: ANN, emailVerified: true });
  expect(rows("select * from subscriber")).toHaveLength(0);
});

it("an unverified account's deletion leaves the address's subscription alone, a verified one's removes it", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  const before = everything();
  for (const emailVerified of [false, null, undefined]) await removeSubscriberOrRefuse({ id: "squatter", email: ANN, emailVerified });
  expect(everything()).toBe(before);
  await removeSubscriberOrRefuse({ id: "owner", email: ANN, emailVerified: true });
  expect(rows("select * from subscriber")).toHaveLength(0);
  expect(rows("select * from consent")).toHaveLength(0);
});

it("the one-click POST with a token and no list or scope withdraws every list (RFC 8058 form body)", async () => {
  await requestJoin(ANN, LIST, ASK);
  await confirm(linkToken());
  sqlite.prepare("insert into consent select subscriber_id, 'other', 'confirmed', source, page, wording, requested_at, confirmed_at, null, null, 'tok-other' from consent").run();
  const app = new Hono().post("/api/lists/unsubscribe", unsubscribeRoute as never);
  const res = await app.request(`/api/lists/unsubscribe?token=${tokenOf(ANN)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  expect(res.status).toBe(200);
  expect(rows("select state, withdrawn_how from consent")).toEqual([{ state: "unsubscribed", withdrawn_how: "one-click" }, { state: "unsubscribed", withdrawn_how: "one-click" }]);
});

it("the next subscribe purges a subscriber whose consent is all pending and older than seven days, and keeps confirmed, younger and unmailed rows", async () => {
  const STALE = "stale@example.com", FRESH = "fresh@example.com", KEPT = "kept@example.com", MIXED = "mixed@example.com";
  for (const to of [STALE, FRESH, KEPT]) await requestJoin(to, LIST, ASK);
  await confirm(linkToken(2)); // kept
  await requestJoin(MIXED, LIST, ASK);
  await confirm(linkToken());
  sqlite.prepare("insert into consent select subscriber_id, 'other', 'pending', source, page, wording, requested_at, null, null, null, 'tok-mixed' from consent where list = ? and subscriber_id = (select id from subscriber where email = ?)").run(LIST, MIXED);
  for (const to of [STALE, KEPT, MIXED]) age(to, CONFIRM_TTL_MS + 1000);
  await requestJoin("new@example.com", LIST, ASK);
  expect(rows("select email from subscriber order by email").map((r) => r.email)).toEqual([FRESH, KEPT, MIXED, "new@example.com"]);
  expect(rows("select * from consent c where not exists (select 1 from subscriber s where s.id = c.subscriber_id)")).toHaveLength(0);
});

it("a subscriber deleted between the insert and the select is answered like any address, and mails nothing", async () => {
  sqlite.exec("create trigger race_insert after insert on subscriber begin delete from subscriber where id = new.id; end");
  expect(await requestJoin(ANN, LIST, ASK)).toBe("ok");
  expect(mail.send).not.toHaveBeenCalled();
  expect(rows("select * from mail_ceiling")).toEqual([]);
});

it("a subscriber deleted after the ceiling claim frees the ceiling slot and answers normally (foreign keys on)", async () => {
  sqlite.exec("create trigger race_ceiling after insert on mail_ceiling begin delete from subscriber; end");
  expect(await requestJoin(ANN, LIST, ASK)).toBe("ok");
  expect(mail.send).not.toHaveBeenCalled();
  expect(rows("select sent from mail_ceiling")).toEqual([{ sent: 0 }]);
  expect(rows("select * from consent")).toHaveLength(0);
});
