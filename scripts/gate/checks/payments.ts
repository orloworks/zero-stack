// Module 6: --payments: the app against a fake Stripe over HTTP (STRIPE_API_URL), with webhooks the gate signs itself (Web Crypto HMAC, as Stripe does).
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTracked } from "../../../src/children";
import { type Obj, startFakeStripe } from "../fake-stripe";
import { authHelpers, type Ctx, GATE_PW } from "../shared";
import { signWebhook } from "../webhook";

// `port` is the first dev server's port: the address the checks start from, before their first restart.
export async function paymentsChecks(ctx: Ctx, { port }: { port: number }): Promise<void> {
  const { config, app, h } = ctx;
  const { onUser, idOf } = h;
  const { r2Keys } = authHelpers(h);
  if (!config.payments) return;
  const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
  const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`payments: ${what}`); };
  const { fake, id, server } = startFakeStripe();
  const SECRET = "whsec_gate_" + crypto.randomUUID().replaceAll("-", "");
  const sign = (payload: string, secret = SECRET) => signWebhook(payload, secret);
  // The app database: the sqlite file that has the subscription table.
  const db = <T,>(fn: (d: Database) => T): T => h.withDb("subscription", fn, { missing: "payments: no database with a subscription table" });
  const subRows = (userId: string) => db((d) => d.query("SELECT * FROM subscription WHERE referenceId = ? ORDER BY id").all(userId) as Obj[]);
  const allSubs = () => db((d) => JSON.stringify(d.query("SELECT id, status, plan, referenceId, stripeSubscriptionId FROM subscription ORDER BY id").all()));
  const restart = (vars: Record<string, string | null>) => h.restart(original, vars);
  const user = (b: string, address: string) => h.makeUser(address, { password: GATE_PW, base: b, name: "Payer", markVerified: false, prefix: "payments: ", requireSignIn: true });
  const call = (b: string, path: string, cookie = "", body?: object, origin = b) => h.request(path, { base: b, redirect: "manual", cookie, body, origin: { foreign: origin } });
  const page = (b: string, cookie = "") => call(b, "/billing", cookie).then((r) => r.text());
  const UPGRADE = { plan: "pro", successUrl: "/billing", cancelUrl: "/billing" };
  const webhook = async (b: string, ev: Obj, sig?: string, secret = SECRET) => {
    const payload = JSON.stringify({ id: id("evt"), object: "event", api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), livemode: false, ...ev });
    return fetch(`${b}/api/auth/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig !== "" && { "stripe-signature": sig ?? (await sign(payload, secret)) }) }, body: payload });
  };
  const now = Math.floor(Date.now() / 1000);
  const subObj = (s: Obj) => ({ object: s });
  const stripeSub = (o: { id: string; customer: string; status: string; metadata?: Obj; cancel?: boolean }) => {
    const price = [...fake.prices.values()].find((x) => x.lookup_key === "pro_monthly")!;
    const s = {
      id: o.id, object: "subscription", customer: o.customer, status: o.status, metadata: o.metadata ?? {}, cancel_at_period_end: !!o.cancel, cancel_at: null, canceled_at: null, ended_at: null, trial_start: null, trial_end: null, schedule: null,
      items: { object: "list", data: [{ id: `si_${o.id}`, object: "subscription_item", quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price }] },
    };
    fake.subs.set(s.id, s);
    return s;
  };
  try {
    let b = `http://localhost:${port}`;
    // Placeholder keys (a fresh scaffold): the app serves, and subscription actions say Stripe isn't set up.
    b = await restart({});
    const early = await user(b, `payer-early-${Date.now()}@example.com`);
    check((await page(b, early)).includes("Stripe isn't set up yet."), "/billing with placeholder keys lacks \"Stripe isn't set up yet.\"");
    const unset = await call(b, "/api/auth/subscription/upgrade", early, UPGRADE);
    check(unset.status === 503 && ((await unset.json()) as Obj).code === "STRIPE_NOT_CONFIGURED", `upgrade with placeholder keys -> ${unset.status}, expected 503 STRIPE_NOT_CONFIGURED`);
    // The placeholder webhook secret is public: an event signed with it is refused.
    const forged = await webhook(b, { type: "customer.subscription.updated", data: { object: { id: "sub_forged", customer: "cus_forged", status: "active", items: { data: [] } } } }, undefined, "whsec_placeholder");
    check(forged.status === 400 && ((await forged.json()) as Obj).code === "STRIPE_WEBHOOK_NOT_CONFIGURED", `a webhook signed with whsec_placeholder -> ${forged.status}, expected 400`);
    console.log("gate: payments with placeholder keys: the app serves, /billing and the upgrade route say Stripe isn't set up yet (503), a webhook signed with whsec_placeholder is 400");

    const STRIPE = { STRIPE_SECRET_KEY: "sk_test_gate", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_URL: `http://127.0.0.1:${server.port}` };
    // The seed script: refuses live keys before calling Stripe, creates the declared price once, and a rerun creates nothing.
    // Async: the fake Stripe runs in this process, so a sync spawn would block it from answering.
    const seed = async (env: Record<string, string>) => {
      const p = spawnTracked([process.execPath, "run", "stripe:seed"], { cwd: app, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
      return { stdout, stderr, exitCode };
    };
    const before = fake.calls.length;
    for (const k of ["sk_live_gate", "rk_live_gate"]) {
      const r = await seed({ ...STRIPE, STRIPE_SECRET_KEY: k });
      check(r.exitCode === 1 && r.stderr.includes("refuses live keys"), `stripe:seed with a ${k.slice(0, 7)} key exited ${r.exitCode}`);
    }
    check(fake.calls.length === before, "stripe:seed called Stripe with a live key");
    const first = await seed(STRIPE), again = await seed(STRIPE);
    check(first.exitCode === 0 && first.stdout.includes("created: pro_monthly"), `stripe:seed -> ${first.exitCode}: ${first.stdout}${first.stderr}`);
    check(again.exitCode === 0 && again.stdout.includes("exists: pro_monthly") && fake.prices.size === 1, `stripe:seed rerun -> ${again.exitCode}, ${fake.prices.size} prices`);
    console.log("gate: stripe:seed refuses sk_live_ and rk_live_ keys before any call, creates the declared price by lookup key, and a rerun creates nothing");

    const bossMail = `payer-boss-${Date.now()}@example.com`; // with --admin: the admin who removes a subscribed user below
    let boss = ""; // the admin's session cookie, set once in the --admin block below
    b = await restart({ ...STRIPE, ...(config.admin && { ADMIN_EMAILS: bossMail }) });
    const [aMail, bMail] = [`payer-a-${Date.now()}@example.com`, `payer-b-${Date.now()}@example.com`];
    const a = await user(b, aMail), other = await user(b, bMail);
    const aId = idOf(aMail), bId = idOf(bMail);
    // Signed out and cross-site requests are refused, and no Stripe call is made for them.
    check((await page(b)).includes("Sign in to manage billing"), "/billing signed out lacks the sign-in line");
    const calls0 = fake.calls.length;
    for (const path of ["/api/auth/subscription/upgrade", "/api/auth/subscription/billing-portal"]) {
      const out = (await call(b, path, "", UPGRADE)).status, cross = (await call(b, path, a, { ...UPGRADE, returnUrl: "/billing" }, "https://evil.test")).status;
      check(out === 401 && cross === 403, `${path}: signed out -> ${out} (expected 401), cross-site -> ${cross} (expected 403)`);
    }
    check(fake.calls.length === calls0, `refused requests reached Stripe: ${fake.calls.slice(calls0).join(", ")}`);
    const none = await page(b, a);
    check(none.includes("You're not on a plan.") && none.includes("Subscribe to Pro") && !none.includes("Manage billing"), "/billing for a user with no plan lacks the no-plan copy or the Subscribe button");
    check((await call(b, "/api/example-plan", a)).status === 403 && (await call(b, "/api/example-plan")).status === 401, "requirePlan: no plan should be 403, signed out 401");
    console.log("gate: payments: /billing signed out and with no plan; checkout and portal refuse signed-out (401) and cross-site (403) requests with no Stripe call; requirePlan 401/403");

    // Checkout: the plugin makes the customer (metadata.userId) and an incomplete row, then a Checkout session for the declared price.
    const up = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
    const upBody = (await up.json()) as Obj;
    check(up.ok && upBody.url === "https://checkout.stripe.test/pay", `upgrade -> ${up.status} ${JSON.stringify(upBody)}`);
    const cus = [...fake.customers.values()].find((c) => c.metadata.userId === aId);
    if (!cus) throw new Error("payments: upgrade made no Stripe customer with metadata.userId");
    const cs = [...fake.sessions.values()].at(-1)!;
    check(db((d) => (d.query("SELECT stripeCustomerId AS c FROM user WHERE id = ?").get(aId) as Obj).c) === cus.id, "the user's stripeCustomerId is not the customer Stripe made");
    check(cs.mode === "subscription" && cs.customer === cus.id && cs.line_items["0"].price === [...fake.prices.keys()][0] && cs.client_reference_id === aId, `checkout session: ${JSON.stringify(cs)}`);
    const [incomplete] = subRows(aId);
    check(incomplete?.status === "incomplete" && cs.metadata.subscriptionId === incomplete.id, `rows after upgrade: ${JSON.stringify(subRows(aId))}`);
    // Bad signatures change nothing.
    const subA = stripeSub({ id: "sub_gateA", customer: cus.id, status: "active", metadata: { subscriptionId: incomplete.id, userId: aId, referenceId: aId } });
    const snapshot = allSubs();
    for (const [what, sig] of [["unsigned", ""], ["wrongly signed", await sign("{}", SECRET)], ["signed with another secret", undefined]] as [string, string | undefined][]) {
      const ev = { type: "customer.subscription.updated", data: subObj({ ...subA, status: "past_due" }) };
      const payload = JSON.stringify(ev);
      const r = await fetch(`${b}/api/auth/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig !== "" && { "stripe-signature": sig ?? (await sign(payload, "whsec_not_the_secret")) }) }, body: payload });
      check(r.status === 400, `${what} webhook -> ${r.status}, expected 400`);
    }
    check(allSubs() === snapshot, "a refused webhook changed the subscription table");
    console.log("gate: payments: upgrade makes the customer and an incomplete row and opens Checkout for the declared price; unsigned, wrongly signed and foreign-secret webhooks get 400 and change nothing");
    // Checkout completes: the success redirect syncs from Stripe at once; then the webhooks arrive (created is skipped for the checkout's own row).
    Object.assign(cs, { subscription: subA.id, payment_status: "paid", status: "complete" });
    const back = await call(b, `/api/auth/subscription/success?callbackURL=%2Fbilling&checkoutSessionId=${cs.id}`, a);
    check(back.status === 302 && new URL(back.headers.get("location") ?? "", b).pathname === "/billing", `success redirect -> ${back.status} ${back.headers.get("location")}`);
    check(subRows(aId)[0].status === "active", "the success redirect did not sync the plan");
    for (const ev of [{ type: "customer.subscription.created", data: subObj(subA) }, { type: "checkout.session.completed", data: subObj(cs) }]) check((await webhook(b, ev)).status === 200, `${ev.type} -> not 200`);
    check(subRows(aId).length === 1 && subRows(aId)[0].stripeSubscriptionId === subA.id, `rows after checkout: ${JSON.stringify(subRows(aId))}`);
    const active = await page(b, a);
    check(active.includes("Pro. Renews on") && active.includes("Manage billing") && !active.includes("Subscribe to Pro"), "/billing after checkout lacks the active plan");
    check((await call(b, "/api/example-plan", a)).status === 200, "requirePlan refused an active plan");
    // Another user sees and manages only their own billing.
    check((await page(b, other)).includes("You're not on a plan."), "another user's /billing shows A's plan");
    const theirs = await call(b, `/api/auth/subscription/list?referenceId=${aId}`, other);
    check(theirs.status === 400 && (await call(b, "/api/auth/subscription/list", other).then((r) => r.json())).length === 0, `another user listing A's subscription -> ${theirs.status}`);
    check((await call(b, "/api/auth/subscription/billing-portal", other, { returnUrl: "/billing", referenceId: aId })).status === 400, "another user opened A's portal");
    check((await call(b, "/api/auth/subscription/billing-portal", other, { returnUrl: "/billing" })).status === 404, "a user with no customer got a portal");
    const portal = await call(b, "/api/auth/subscription/billing-portal", a, { returnUrl: "/billing" });
    check(portal.ok && ((await portal.json()) as Obj).url === "https://billing.stripe.test/session", `portal -> ${portal.status}`);
    console.log("gate: payments: the success redirect shows the plan before any webhook; created and checkout.session.completed answer 200 and keep one row; requirePlan 200; another user can't read or manage it; the portal opens");

    // #85, with --admin: plan-gated feature switches and the admin Billing section. `a` is active on pro here; `other` has no plan and no Stripe customer.
    if (config.admin) {
      boss = await user(b, bossMail);
      onUser(bossMail, "UPDATE user SET emailVerified = 1 WHERE id = ?");
      const F = "example-feature";
      const gated = (cookie: string) => call(b, `/api/${F}`, cookie).then((r) => r.status);
      const setGlobal = (state: string) => call(b, `/api/admin/features/${F}`, boss, { state }).then((r) => r.status);
      const setUser = (uid: string, state: string) => call(b, `/api/admin/users/${uid}/features/${F}`, boss, { state }).then((r) => r.status);
      check((await setGlobal("off")) === 200, "could not turn the feature off for everyone");
      check((await gated(other)) === 403, "a plan-only feature is on for a user with no plan");
      check((await gated(a)) === 200, "a plan-only feature is off for a user on the plan");
      check((await setGlobal("kill")) === 200 && (await gated(a)) === 403, "the kill switch did not beat the plan");
      check((await setGlobal("off")) === 200 && (await gated(a)) === 200, "the plan feature did not come back after the kill switch");
      check((await setUser(bId, "on")) === 200 && (await gated(other)) === 200, "a comped user (override on) with no plan was refused");
      check((await setUser(aId, "off")) === 200 && (await gated(a)) === 403, "an override off did not beat the plan");
      check((await setUser(bId, "default")) === 200 && (await setUser(aId, "default")) === 200 && (await gated(other)) === 403 && (await gated(a)) === 200, "resetting the overrides did not restore the plan result");
      const text = (path: string) => call(b, path, boss).then((r) => r.text());
      check((await text("/admin/features")).includes("Also on for users on the pro plan"), "/admin/features does not say the feature is on for the pro plan");
      check((await text(`/admin/users/${aId}`)).includes("Effective: On: included in the user"), "user detail does not say On: included in the user's plan");
      const billing = await text(`/admin/users/${aId}`);
      check(billing.includes("Billing") && billing.includes("Active, renews on") && billing.includes(`https://dashboard.stripe.com/test/customers/${cus.id}`), "the admin Billing section lacks the plan, status or the test-mode dashboard link");
      check(!billing.includes("sk_test_gate"), "the admin page contains the Stripe key");
      const empty = await text(`/admin/users/${bId}`);
      check(empty.includes("No subscription.") && empty.includes("No Stripe customer yet") && !empty.includes("dashboard.stripe.com"), "the admin Billing section has no empty state for a user with no subscription");
      console.log("gate: payments + admin: a plan-only feature is off without the plan, on with it, off under the kill switch, on for a comped user with no plan, off for an override off; Features says it is on for users on the pro plan; the user page shows Billing (plan, status, test-mode Stripe link) and a clear empty state");
    }

    // Stripe's state changes (the fake's subscription is the live one the app reads back), then the event for it arrives.
    const emit = (type: string, change: Obj) => webhook(b, { type, data: subObj({ ...Object.assign(subA, change) }) });
    // past_due: shown with the fix-your-card copy, still counts for requirePlan, and blocks a second Checkout.
    check((await emit("customer.subscription.updated", { status: "past_due" })).status === 200, "updated past_due -> not 200");
    const due = await page(b, a);
    check(due.includes("Your last payment failed") && due.includes("Manage billing") && !due.includes("Subscribe to Pro"), "/billing for past_due lacks the failure copy or still offers Subscribe");
    check((await call(b, "/api/example-plan", a)).status === 200, "requirePlan refused a past_due plan");
    const sessions = fake.sessions.size;
    const second = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
    check(second.status === 400 && ((await second.json()) as Obj).code === "SUBSCRIPTION_NEEDS_CARD" && fake.sessions.size === sessions, `a past_due user's second upgrade -> ${second.status}`);
    // unpaid: inactive for requirePlan, and still no second Checkout.
    check((await emit("customer.subscription.updated", { status: "unpaid" })).status === 200, "updated unpaid -> not 200");
    check((await page(b, a)).includes("is paused because payments failed") && (await call(b, "/api/example-plan", a)).status === 403, "unpaid lacks the paused copy or passed requirePlan");
    if (config.admin) check((await call(b, "/api/example-feature", a)).status === 403, "an unpaid subscription still grants a plan feature");
    const third = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
    check(third.status === 400 && ((await third.json()) as Obj).code === "SUBSCRIPTION_NEEDS_CARD" && fake.sessions.size === sessions, `an unpaid user's second upgrade -> ${third.status}`);
    // A lost write: the database refuses the update (the plugin's and the sync's), so the event answers an error and Stripe retries; the retry lands.
    db((d) => d.run("CREATE TRIGGER gate_fail BEFORE UPDATE ON subscription WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'gate'); END"));
    const lost = await emit("customer.subscription.updated", { status: "active", cancel_at_period_end: true });
    db((d) => d.run("DROP TRIGGER gate_fail"));
    check(lost.status >= 400 && subRows(aId)[0].status === "unpaid", `an update whose write failed -> ${lost.status}, row ${subRows(aId)[0].status}`);
    check((await emit("customer.subscription.updated", {})).status === 200, "the retried update -> not 200");
    check((await page(b, a)).includes("Pro. Cancelling, ends on"), "/billing for a cancelling plan lacks the end date");
    console.log("gate: payments: past_due shows the fix-your-card copy, still passes requirePlan and refuses a second Checkout; unpaid fails requirePlan and refuses one too; a failed write answers an error and the retry lands; cancelling shows its end date");

    // No user holds the customer (a dashboard subscription, or a deleted user whose rows are gone): 200 and nothing changes.
    const ghostMail = `payer-ghost-${Date.now()}@example.com`;
    const ghost = await user(b, ghostMail);
    check((await call(b, "/api/auth/subscription/upgrade", ghost, UPGRADE)).ok, "the ghost user's upgrade failed");
    const ghostId = idOf(ghostMail), ghostCus = [...fake.customers.values()].find((c) => c.metadata.userId === ghostId)!.id;
    db((d) => { d.run("DELETE FROM subscription WHERE referenceId = ?", [ghostId]); d.run("DELETE FROM session WHERE userId = ?", [ghostId]); d.run("DELETE FROM account WHERE userId = ?", [ghostId]); d.run("DELETE FROM user WHERE id = ?", [ghostId]); });
    const quiet = allSubs();
    for (const [customer, why] of [["cus_unknown_gate", "an unknown customer"], [ghostCus, "a deleted user"]])
      for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
        const r = await webhook(b, { type, data: subObj(stripeSub({ id: `sub_${customer}`, customer, status: "past_due" })) });
        check(r.status === 200, `${type} for ${why} -> ${r.status}, expected 200`);
      }
    check(allSubs() === quiet, "an event for a customer no user holds changed the subscription table");
    console.log("gate: payments: subscription events for an unknown customer and for a deleted user's customer answer 200 and change nothing");

    const older = { ...subA, status: "active", cancel_at_period_end: false }; // an update Stripe sent before the deletion
    check((await emit("customer.subscription.deleted", { status: "canceled" })).status === 200, "deleted -> not 200");
    const ended = await page(b, a);
    check(subRows(aId)[0].status === "canceled" && ended.includes("Your Pro plan has ended.") && ended.includes("Subscribe to Pro"), "/billing after deletion lacks the ended copy or the Subscribe button");
    check((await call(b, "/api/example-plan", a)).status === 403, "requirePlan let a canceled plan through");
    if (config.admin) check((await call(b, "/api/example-feature", a)).status === 403, "a canceled subscription still grants a plan feature");
    // Out of order: that older update, retried after the deletion, must not bring the plan back.
    check((await webhook(b, { type: "customer.subscription.updated", data: subObj(older) })).status === 200, "a late older update -> not 200");
    check(subRows(aId)[0].status === "canceled" && (await call(b, "/api/example-plan", a)).status === 403, `a late older update revived the plan: row ${subRows(aId)[0].status}`);
    console.log("gate: payments: a deleted subscription shows as ended with Subscribe back, requirePlan refuses it, and an older update retried afterwards leaves it canceled");

    // #84: deleting a user cancels their subscriptions in Stripe first, on both paths (self-service, admin removal), ahead of the storage purge.
    // Each doomed user has a customer, the checkout's row, and one subscription per status in Stripe that the app has no row for (no webhook yet).
    const removals: [string, "all" | "cancel", (d: { cookie: string; uid: string }) => Promise<Response>][] = [];
    if (config.accountDeletion) removals.push(["self-service deletion", "all", (d) => call(b, "/api/auth/delete-user", d.cookie, { password: GATE_PW })]);
    if (config.admin) {
      removals.push(["admin removal", "cancel", (d) => call(b, "/api/auth/admin/remove-user", boss, { userId: d.uid })]);
    }
    for (const [how, outage, remove] of removals) {
      const mail = `payer-doomed-${removals.length}-${how.length}-${Date.now()}@example.com`;
      const cookie = await user(b, mail), uid = idOf(mail), d = { cookie, uid };
      check((await call(b, "/api/auth/subscription/upgrade", cookie, UPGRADE)).ok, `${how}: the doomed user's upgrade failed`);
      const customer = [...fake.customers.values()].find((c) => c.metadata.userId === uid)!.id;
      const subs = ["past_due", "active", "canceled", "incomplete_expired"].map((status) => stripeSub({ id: `sub_${uid}_${status}`, customer, status }));
      const statuses = () => subs.map((x) => x.status).join(",");
      // The upgrade left a Checkout session open: paid after the deletion it would start a subscription nobody owns.
      const checkout = [...fake.sessions.values()].find((x) => x.customer === customer)!;
      check(checkout.status === "open", `${how}: the doomed user's Checkout session is ${checkout.status}, expected open`);
      const file = `users/${uid}/keep.txt`;
      if (config.storage) {
        const put = await fetch(`${b}/api/files/keep.txt`, { method: "PUT", body: "keep", headers: { cookie, "content-type": "text/plain" } });
        check(put.status === 201 && r2Keys().includes(file), `${how}: the doomed user's upload -> ${put.status}`);
      }
      // Stripe is down: the deletion stops with the code and message the pages show; the user, their rows, their files and their subscriptions are
      // untouched. Checkout sessions are expired first, so when only the cancel fails the open session is already expired (a retry is safe).
      fake.down = outage;
      const refused = await remove(d), why = (await refused.json()) as Obj;
      fake.down = "";
      check(refused.status === 500 && why.code === "BILLING_CANCEL_FAILED" && why.message === "Couldn't cancel the subscription in Stripe, so the account was not deleted. Try again.", `${how} with Stripe down (${outage}) -> ${refused.status} ${JSON.stringify(why)}`);
      check(h.hasUser(mail) && subRows(uid).length === 1 && statuses() === "past_due,active,canceled,incomplete_expired" && checkout.status === (outage === "all" ? "open" : "expired"), `${how} with Stripe down deleted the user or their rows, or cancelled something`);
      check(!config.storage || r2Keys().includes(file), `${how} with Stripe down purged the user's files`);
      // Stripe is back: every subscription that hadn't ended is cancelled (past_due included, the ended ones left alone), then the user, rows and files go.
      const mark = fake.calls.length;
      const gone = await remove(d);
      check(gone.status === 200, `${how} -> ${gone.status}`);
      const cancelled = fake.calls.slice(mark).filter((c) => c.startsWith("DELETE "));
      check(statuses() === "canceled,canceled,canceled,incomplete_expired" && cancelled.join() === [subs[0]!, subs[1]!].map((x) => `DELETE /v1/subscriptions/${x.id}`).join(), `${how}: Stripe has ${statuses()} after ${cancelled.join(", ") || "no cancel"}`);
      check(checkout.status === "expired", `${how} left the user's Checkout session ${checkout.status}`);
      check(!h.hasUser(mail) && subRows(uid).length === 0, `${how} left the user or their subscription rows`);
      check(!config.storage || !r2Keys().some((k) => k.startsWith(`users/${uid}/`)), `${how} left the user's files`);
      // Stripe's event for the cancellation arrives after the user is gone: 200, so Stripe doesn't retry. It is on a declared price, so the
      // sync does not skip it as someone else's: it gets as far as finding that no user holds the customer.
      check(subs[0]!.items.data[0]!.price.lookup_key === "pro_monthly" && !db((d) => d.query("SELECT 1 FROM user WHERE stripeCustomerId = ?").get(customer)), `${how}: the late event is not on a declared price, or a user still holds ${customer}`);
      const late = await webhook(b, { type: "customer.subscription.deleted", data: subObj(subs[0]!) });
      check(late.status === 200 && subRows(uid).length === 0, `${how}: a late customer.subscription.deleted -> ${late.status}`);
      console.log(`gate: payments: ${how} stops with 500 BILLING_CANCEL_FAILED while Stripe is down (user, rows${config.storage ? ", files" : ""} and Stripe untouched); then cancels the past_due and active subscriptions and expires the open Checkout session in Stripe first, deletes the user${config.storage ? ", files" : ""} and subscription rows, and a late customer.subscription.deleted answers 200`);
    }

    // Static checks: one better-auth, the webhook's rate-limit exemption, the plugin's tables in the migration.
    const copies: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const sub = join(dir, e.name);
        if (e.name === "better-auth" && existsSync(join(sub, "package.json"))) copies.push(sub);
        if (e.name.startsWith("@")) walk(sub);
        else if (existsSync(join(sub, "node_modules"))) walk(join(sub, "node_modules"));
      }
    };
    walk(join(app, "node_modules"));
    check(copies.length === 1, `expected one better-auth, found ${copies.join(", ") || "none"}`);
    check(/customRules:\s*\{\s*"\/stripe\/webhook":\s*false/.test(readFileSync(join(app, "auth.ts"), "utf8")), "auth.ts does not exempt /stripe/webhook from rate limiting");
    const sql = readdirSync(join(app, "db/migrations")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(app, "db/migrations", f), "utf8")).join("\n");
    check(/CREATE TABLE\s+[`"']?subscription\b/.test(sql) && /stripeCustomerId/.test(sql), "no migration creates the subscription table and user.stripeCustomerId");
    console.log("gate: payments: exactly one better-auth installed; the webhook path is exempt from rate limiting; the migration has the plugin's tables");
  } finally {
    server.stop(true);
    writeFileSync(envFile, original);
  }
}
