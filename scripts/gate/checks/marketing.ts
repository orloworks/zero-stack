// Module 6b: --marketing: joining, confirming, leaving and deleting, over HTTP with the dev inbox (#113). No marketing mail exists yet: the only mail is the confirmation,
// through the transactional sender. The ten-minute throttle and the seven-day expiry are tested by backdating rows in the app database.
// The deletion helpers at the top are used by the payments module too, which holds the subscription state their refusal has to leave alone.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateHarness } from "../harness";
import { type Ctx, GATE_PW } from "../shared";

const SUBJECT = "Confirm your subscription";
const CHECK_INBOX = "Check your inbox to confirm";
export const REMOVAL_FAILED = { code: "SUBSCRIBER_REMOVAL_FAILED", message: "Couldn't remove the account's email subscriptions, so the account was not deleted. Try again." };
const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// A subscriber with a consent row per list, as the form and the confirm page would leave it, made straight in the app database. Returns its unsubscribe token.
export function seedSubscriber(h: GateHarness, email: string, state = "confirmed", lists: string[] = ["newsletter"]): string {
  const id = crypto.randomUUID(), token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  h.withDb("consent", (d) => {
    d.run("INSERT INTO subscriber (id, email, unsubscribe_token, created_at) VALUES (?, ?, ?, ?)", [id, email.toLowerCase(), token, Date.now()]);
    for (const list of lists)
      d.run("INSERT INTO consent (subscriber_id, list, state, source, page, wording, requested_at, confirmed_at, confirm_token) VALUES (?, ?, ?, 'form', '/subscribe', 'gate', ?, ?, ?)",
        [id, list, state, Date.now(), state === "confirmed" ? Date.now() : null, crypto.randomUUID().replaceAll("-", "")]);
  });
  return token;
}

// How many subscriber rows and consent rows the address has.
export const subscriberCounts = (h: GateHarness, email: string) =>
  h.withDb("consent", (d) => d.query("SELECT (SELECT count(*) FROM subscriber WHERE email = ?1) AS subscribers, (SELECT count(*) FROM consent WHERE subscriber_id IN (SELECT id FROM subscriber WHERE email = ?1)) AS consents").get(email.toLowerCase()) as { subscribers: number; consents: number }, { readonly: true });

// Runs `fn` with the database refusing to delete a subscriber: an aborting trigger added here and dropped again, whatever `fn` does.
export async function failRemoval<T>(h: GateHarness, fn: () => Promise<T>): Promise<T> {
  h.withDb("subscriber", (d) => d.run("CREATE TRIGGER gate_abort_delete BEFORE DELETE ON subscriber BEGIN SELECT RAISE(ABORT, 'gate: removal refused'); END"));
  try {
    return await fn();
  } finally {
    h.withDb("subscriber", (d) => d.run("DROP TRIGGER IF EXISTS gate_abort_delete"));
  }
}

export async function marketingChecks(ctx: Ctx): Promise<void> {
  const { config, app, h } = ctx;
  if (!config.marketing) return;
  const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
  const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`marketing: ${what}`); };
  const ts = Date.now();
  const addr = (n: string) => `${n}-${ts}@example.com`;
  try {
    const b = await h.restart(original, {}); // the scaffold's .env: ADMIN_EMAILS=@example.com, the Turnstile test secret
    const send = (path: string, o: { method?: string; headers?: Record<string, string>; body?: BodyInit; cookie?: string } = {}) =>
      fetch(b + path, { method: o.method ?? "POST", redirect: "manual", headers: { ...(o.cookie && { cookie: o.cookie }), ...o.headers }, body: o.body }); // no Origin, no cookie unless given
    const subscribe = (email: string, o: { captcha?: boolean; origin?: "same" | "none" | { foreign: string }; list?: string } = {}) =>
      h.request("/api/lists/subscribe", { body: { email, list: o.list ?? "newsletter" }, captcha: o.captcha ?? true, origin: o.origin });
    const same = async (r: Response) => `${r.status} ${await r.text()}`;
    const q = <T,>(sql: string, ...args: (string | number)[]) => h.withDb("consent", (d) => d.query(sql).all(...args) as T[], { readonly: true });
    const consent = (email: string) => q<Record<string, any>>("SELECT c.* FROM consent c JOIN subscriber s ON s.id = c.subscriber_id WHERE s.email = ? ORDER BY c.list", email.toLowerCase());
    const unsubToken = (email: string) => q<{ t: string }>("SELECT unsubscribe_token AS t FROM subscriber WHERE email = ?", email.toLowerCase())[0]!.t;
    // Moves the address's times back: its last confirmation mail (the ten-minute throttle) and its consent requests (the seven-day expiry).
    const age = (email: string, ms: number) => h.withDb("consent", (d) => {
      d.run("UPDATE subscriber SET last_mail_at = last_mail_at - ?1 WHERE email = ?2", [ms, email.toLowerCase()]);
      d.run("UPDATE consent SET requested_at = requested_at - ?1 WHERE subscriber_id = (SELECT id FROM subscriber WHERE email = ?2)", [ms, email.toLowerCase()]);
    });
    const mails = (email: string) => h.mailUrls(SUBJECT, email, b, "/confirm");
    // A send writes last_mail_at and the consent's confirm_token before it mails, so a late wrong send shows there even if its mail has not landed yet.
    const sendState = (email: string) => h.withDb("consent", (d) => JSON.stringify(d.query("SELECT s.last_mail_at, (SELECT group_concat(c.confirm_token) FROM consent c WHERE c.subscriber_id = s.id) AS tokens FROM subscriber s WHERE s.email = ?").get(email.toLowerCase())), { readonly: true });
    // `n` mails have arrived and no more do. `before` is sendState taken BEFORE a request that must not send: the wait compares against it, so a wrong send that
    // writes both fields within milliseconds is caught. Without it (a request that must send once) the state is taken after the mail lands, which catches a second send.
    const settled = async (email: string, n: number, what: string, before?: string) => {
      check((await h.waitMails(SUBJECT, email, n, b, "/confirm")).length === n, `${what}: expected ${n} confirmation mail(s) for ${email}`);
      const sent = before ?? sendState(email);
      await Bun.sleep(750);
      check((await mails(email)).length === n && sendState(email) === sent, `${what}: more than ${n} confirmation mail(s) for ${email}, or a send changed last_mail_at or the confirm token`);
    };

    // 1. The three pages are public and say what they should; a GET of each changes nothing (the rows are compared at the end of each step below).
    const page = async (path: string) => { const r = await h.request(path, { origin: "none" }); return { status: r.status, text: await r.text() }; };
    const subscribePage = await page("/subscribe");
    check(subscribePage.status === 200 && /type="email"/.test(subscribePage.text) && /Newsletter/.test(subscribePage.text), `/subscribe -> ${subscribePage.status} without the form`);
    const bare = await page("/confirm");
    check(bare.status === 200 && /isn&#39;t valid|isn't valid/.test(bare.text), "/confirm with no token does not say the link is not valid");
    console.log("gate: marketing: /subscribe, /confirm and /unsubscribe are public pages");

    // 2. Subscribe: no Turnstile token is refused before anything is written; the answer is the same for a new, pending, confirmed and unsubscribed address.
    const ann = addr("ann");
    const noToken = await subscribe(ann, { captcha: false });
    check(noToken.status === 400, `a subscribe with no Turnstile token -> ${noToken.status}, expected 400`);
    for (const [what, origin] of [["no Origin", "none"], ["a foreign Origin", { foreign: "https://evil.example" }]] as const) {
      const r = await subscribe(ann, { origin });
      check(r.status === 403, `a subscribe with ${what} -> ${r.status}, expected 403 (the other-site form is a later ticket)`);
    }
    check((await subscribe(ann, { list: "nope" })).status === 400 && (await subscribe("not-an-email")).status === 400, "a subscribe for an unknown list or a bad address was not 400");
    await Bun.sleep(500);
    check(!consent(ann).length && !(await mails(ann)).length, "a refused subscribe wrote a row or mailed");
    const first = await subscribe(ann);
    const firstAnswer = await same(first);
    check(first.status === 200 && firstAnswer.includes(CHECK_INBOX), `subscribe -> ${firstAnswer}`);
    await settled(ann, 1, "a new address");
    check(consent(ann).length === 1 && consent(ann)[0]!.state === "pending" && consent(ann)[0]!.confirmed_at === null, "a new address is not pending");
    const pendingState = sendState(ann);
    check((await same(await subscribe(ann))) === firstAnswer, "a pending address got a different answer");
    await settled(ann, 1, "a second request inside ten minutes", pendingState);
    const [raw] = await h.rawMails(SUBJECT, ann, b);
    check(raw && /^subject:\s*Confirm your subscription/im.test(raw) && /content-type:\s*text\/plain/i.test(raw) && !/content-type:\s*text\/html/i.test(raw) && /\/confirm\?token=/.test(raw), "the confirmation is not one plain-text mail with the confirm link");
    // Past ten minutes a request mails again, with a new link that replaces the old one.
    const [link1] = await mails(ann);
    age(ann, TEN_MINUTES + 5000);
    await subscribe(ann);
    await settled(ann, 2, "a request after ten minutes");
    const links = await mails(ann);
    const link = links.find((l) => l.searchParams.get("token") !== link1!.searchParams.get("token"));
    check(link, "the second confirmation mail has the same link as the first");
    console.log("gate: marketing: subscribe without a Turnstile token (and from no Origin or a foreign one) is refused and writes nothing; one plain-text confirmation mail goes out, none inside ten minutes, one more after");

    // 3. Confirm: the GET changes nothing; an expired and an unknown link do not confirm; a press from no Origin is refused; the POST confirms.
    const stateOf = (email: string) => JSON.stringify(consent(email));
    const before = stateOf(ann);
    const get = await h.request(link!.pathname + link!.search, { origin: "none" });
    const getText = await get.text();
    check(get.status === 200 && /Press Confirm to get/.test(getText) && /<button/.test(getText) && !/older than seven days/.test(getText) && stateOf(ann) === before, `GET of the confirm link -> ${get.status}, or it changed the row`);
    const token = link!.searchParams.get("token")!;
    const press = (t: string, o: { origin?: "same" | "none" } = {}) => h.request("/api/lists/confirm", { body: { token: t }, origin: o.origin });
    check((await press(token, { origin: "none" })).status === 403 && stateOf(ann) === before, "a Confirm press with no Origin was not refused");
    check((await press("no-such-token")).status === 400 && (await press("")).status === 400 && stateOf(ann) === before, "an unknown token was not refused or changed a row");
    age(ann, 8 * DAY); // expired: the request is eight days old
    const expiredPage = await page(link!.pathname + link!.search);
    check(/older than seven days/.test(expiredPage.text), "the page for an expired link does not say it is older than seven days");
    const expired = await press(token);
    check(expired.status === 400 && consent(ann)[0]!.state === "pending", `an expired link -> ${expired.status}, state ${consent(ann)[0]!.state}`);
    age(ann, -8 * DAY);
    check((await press(token)).status === 200 && consent(ann)[0]!.state === "confirmed" && consent(ann)[0]!.confirmed_at > 0, "the Confirm press did not confirm");
    check((await press(token)).status === 200, "a second Confirm press was not answered as confirmed");
    console.log("gate: marketing: the confirm GET changes nothing, an expired link says to ask again and does not confirm, an unknown token and a press with no Origin do not, the press confirms");

    // 4. A confirmed address gets the same answer and no mail (the throttle is out of the way); the form answers the same for an unsubscribed one.
    age(ann, TEN_MINUTES + 5000);
    const confirmedState = sendState(ann);
    const confirmedAnswer = await same(await subscribe(ann));
    await settled(ann, 2, "a confirmed address", confirmedState);
    check(confirmedAnswer === firstAnswer && consent(ann)[0]!.state === "confirmed", "a confirmed address got a different answer or was changed");
    const gone = addr("gone");
    seedSubscriber(h, gone, "unsubscribed");
    check((await same(await subscribe(gone))) === firstAnswer, "an unsubscribed address got a different answer");
    await settled(gone, 1, "an unsubscribed address asking again");
    check(consent(gone)[0]!.state === "pending", "an unsubscribed address asking again is not pending");
    console.log("gate: marketing: the form answers the same for a new, pending, confirmed and unsubscribed address; a confirmed address gets no mail");

    // 5. Unsubscribe: the GET changes nothing; the POST needs no cookie and no Origin, in each body encoding, answers 200 with no redirect, and is repeatable.
    const stay = addr("stay");
    const stayToken = seedSubscriber(h, stay, "confirmed", ["newsletter", "second"]);
    const unsubPath = (t: string, list = "newsletter") => `/unsubscribe?token=${t}&list=${list}`;
    const unsubPost = (t: string, list = "newsletter") => `/api/lists/unsubscribe?token=${t}&list=${list}`;
    const stayBefore = stateOf(stay);
    const unsubPage = await page(unsubPath(stayToken));
    check(unsubPage.status === 200 && /Unsubscribe from Newsletter/.test(unsubPage.text) && /Unsubscribe from everything/.test(unsubPage.text) && stateOf(stay) === stayBefore, "the unsubscribe page lacks its two choices, or its GET changed the row");
    const form = () => new URLSearchParams({ "List-Unsubscribe": "One-Click" });
    const multipart = () => { const f = new FormData(); f.set("List-Unsubscribe", "One-Click"); return f; };
    const encodings: [string, () => { body: BodyInit; headers?: Record<string, string> }, string][] = [
      ["urlencoded", () => ({ body: form() }), "one-click"],
      ["multipart", () => ({ body: multipart() }), "one-click"],
      ["json", () => ({ body: JSON.stringify({}), headers: { "content-type": "application/json" } }), "link"],
    ];
    let knownAnswer = "";
    for (const [i, [how, make, withdrawn]] of encodings.entries()) {
      const who = addr(`leaver-${i}`);
      const t = seedSubscriber(h, who);
      const r = await send(unsubPost(t), make());
      const answer = await same(r);
      knownAnswer ||= answer;
      check(r.status === 200 && !r.headers.get("location") && answer === knownAnswer, `a ${how} unsubscribe with no cookie and no Origin -> ${r.status} ${r.headers.get("location") ?? ""}`);
      check(consent(who)[0]!.state === "unsubscribed" && consent(who)[0]!.withdrawn_how === withdrawn && consent(who)[0]!.confirm_token === null, `a ${how} unsubscribe did not unsubscribe (${JSON.stringify(consent(who)[0])})`);
      check((await send(unsubPost(t), make())).status === 200 && consent(who)[0]!.state === "unsubscribed", `a repeated ${how} unsubscribe was not 200`);
    }
    const unknown = await send(unsubPost("unknown-token"), { body: form() });
    check(unknown.status === 200 && (await same(unknown)) === knownAnswer, "an unknown token did not get the same answer");
    // This list leaves the other list alone; everything covers every list.
    check((await send(unsubPost(stayToken), { body: form() })).status === 200, "unsubscribing from this list was not 200");
    check(consent(stay).map((c) => `${c.list}:${c.state}`).join() === "newsletter:unsubscribed,second:confirmed", `this list left ${consent(stay).map((c) => `${c.list}:${c.state}`)}`);
    const everything = new URLSearchParams({ scope: "all" });
    check((await send(unsubPost(stayToken), { body: everything })).status === 200 && consent(stay).every((c) => c.state === "unsubscribed"), "everything did not cover every list");
    console.log("gate: marketing: the unsubscribe GET changes nothing; the POST with no cookie and no Origin unsubscribes from urlencoded, multipart and JSON bodies, answers 200 with no redirect, is repeatable, gives an unknown token the same answer; this list leaves the other alone and everything covers every list");

    // 6. Subscribe again mails a confirmation and confirms nothing by itself (an unknown token gets the same answer and no mail).
    const again = (t: string, list = "newsletter") => h.request("/api/lists/resubscribe", { body: { token: t, list } });
    const stayAnswer = await same(await again(stayToken));
    check(stayAnswer.includes(CHECK_INBOX), `subscribe again -> ${stayAnswer}`);
    await settled(stay, 1, "subscribe again");
    check(consent(stay)[0]!.state === "pending" && consent(stay)[0]!.confirmed_at === null && consent(stay)[0]!.withdrawn_at === null, "subscribe again did not leave a pending row");
    const stayState = sendState(stay);
    await again(stayToken);
    await settled(stay, 1, "subscribe again inside ten minutes", stayState);
    check((await same(await again("unknown-token"))) === stayAnswer, "subscribe again with an unknown token got a different answer");
    console.log("gate: marketing: Subscribe again mails one confirmation and leaves the row pending, never confirmed");

    // 7. Deleting an account removes its subscriber and consent first, on both paths; with the removal made to fail the account is not deleted; the same
    // address subscribing afterwards is pending until confirmed.
    const bossCookie = await h.makeUser(addr("boss"), { password: GATE_PW, base: b });
    for (const how of config.accountDeletion ? (["self-service deletion", "admin removal"] as const) : (["admin removal"] as const)) {
      const mail = addr(how === "admin removal" ? "doomed-admin" : "doomed-self");
      const cookie = await h.makeUser(mail, { password: GATE_PW, base: b, requireSignIn: true });
      const uid = h.idOf(mail);
      seedSubscriber(h, mail, "confirmed", ["newsletter", "second"]);
      const remove = () => (how === "admin removal" ? h.request("/api/auth/admin/remove-user", { body: { userId: uid }, cookie: bossCookie }) : h.authPost("/api/auth/delete-user", { password: GATE_PW }, b, cookie));
      const refused = await failRemoval(h, remove);
      const why = (await refused.json()) as { code?: string; message?: string };
      check(refused.status === 500 && why.code === REMOVAL_FAILED.code && why.message === REMOVAL_FAILED.message, `${how} with the removal failing -> ${refused.status} ${JSON.stringify(why)}`);
      const kept = subscriberCounts(h, mail);
      check(h.hasUser(mail) && kept.subscribers === 1 && kept.consents === 2, `${how} with the removal failing deleted the account or changed the subscriber (${JSON.stringify(kept)})`);
      const done = await remove();
      check(done.ok, `${how} -> ${done.status}`);
      const left = subscriberCounts(h, mail);
      check(!h.hasUser(mail) && left.subscribers === 0 && left.consents === 0, `${how} left the user or the subscriber rows (${JSON.stringify(left)})`);
      // Nothing of the old consent is kept: the same address subscribing again starts pending and needs its own confirmation.
      check((await subscribe(mail)).status === 200, `${how}: subscribing the deleted address again failed`);
      await settled(mail, 1, `${how}: the deleted address subscribing again`);
      check(consent(mail).length === 1 && consent(mail)[0]!.state === "pending" && consent(mail)[0]!.confirmed_at === null, `${how}: the address subscribing again is not pending (${JSON.stringify(consent(mail))})`);
      console.log(`gate: marketing: ${how} stops with 500 SUBSCRIBER_REMOVAL_FAILED while the removal fails (account, subscriber and consent untouched), then removes the subscriber and consent rows with the account; the address subscribing again is pending`);
    }

    // 8. An UNVERIFIED account does not own its address: sign-up does not wait for verification, so a visitor can register someone else's address. Deleting that account,
    // by an admin or (where an unverified user can sign in) by itself, deletes the account and leaves the real owner's confirmed subscription alone.
    for (const how of config.accountDeletion && !config.inviteOnly ? (["self-service deletion", "admin removal"] as const) : (["admin removal"] as const)) {
      const squat = addr(how === "admin removal" ? "squatter-admin" : "squatter-self");
      seedSubscriber(h, squat, "confirmed", ["newsletter"]); // the real owner's confirmed subscription
      const cookie = await h.makeUser(squat, { password: GATE_PW, base: b, inviteLink: false, markVerified: false });
      const uid = h.idOf(squat);
      check(h.hasUser(squat) && !(await h.withDb("user", (d) => (d.query("SELECT emailVerified AS v FROM user WHERE id = ?").get(uid) as { v: number }).v, { readonly: true })), `${how}: the squatter's account is verified`);
      const gone = await (how === "admin removal" ? h.request("/api/auth/admin/remove-user", { body: { userId: uid }, cookie: bossCookie }) : h.authPost("/api/auth/delete-user", { password: GATE_PW }, b, cookie));
      check(gone.ok, `${how} of an unverified account -> ${gone.status}`);
      const kept = subscriberCounts(h, squat);
      check(!h.hasUser(squat) && kept.subscribers === 1 && kept.consents === 1 && consent(squat)[0]!.state === "confirmed", `${how} of an unverified account removed or changed the address's subscription (${JSON.stringify(kept)})`);
      console.log(`gate: marketing: ${how} of an unverified account deletes it and leaves the address's confirmed subscription alone`);
    }
  } finally {
    writeFileSync(envFile, original);
  }
}
