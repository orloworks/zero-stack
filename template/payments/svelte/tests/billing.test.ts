import { expect, it, vi } from "vite-plus/test";
import { billingView, type SubscriptionRow } from "../src/lib/billing-view";
import { lookupKeys, stripePlans } from "../src/plans";
import { stripeClient, stripeConfigured } from "../src/stripe";

// Tests run in Node without Worker bindings: the session is a stand-in and the database is an in-memory SQLite behind the same drizzle calls.
const session = vi.hoisted(() => ({ user: null as { id: string } | null, down: false }));
vi.mock("void/auth", () => ({
  requireAuth: () => {
    if (!session.user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return session.user;
  },
}));
vi.mock("void/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { and, eq, inArray, or } = await import("drizzle-orm");
  const sqlite = new Database(":memory:");
  sqlite.exec(`create table user (id text primary key, name text not null, email text not null, emailVerified integer not null, createdAt integer not null, updatedAt integer not null, stripeCustomerId text);
    create table subscription (id text primary key, plan text not null, referenceId text not null, stripeCustomerId text, stripeSubscriptionId text, status text not null,
      periodStart integer, periodEnd integer, trialStart integer, trialEnd integer, cancelAtPeriodEnd integer, cancelAt integer, canceledAt integer, endedAt integer,
      seats integer, billingInterval text, stripeScheduleId text);
    insert into user values ('u1', 'U', 'u@example.com', 1, 0, 0, 'cus_1');`);
  const db = drizzle(sqlite);
  return {
    get db() {
      if (session.down) throw new Error("database down");
      return db;
    },
    and, eq, inArray, or, sqlite,
  };
});

// The test brings its own plans, "pro" and "business", so it passes whatever src/app/plans.ts declares (examples replaced, or the list emptied).
vi.mock("../src/app/plans", () => ({
  PLANS: [
    { name: "pro", label: "Pro", currency: "usd", monthly: { lookupKey: "pro_monthly", amount: 1000 } },
    { name: "business", label: "Business", currency: "usd", monthly: { lookupKey: "business_monthly", amount: 5000 } },
  ],
}));

const { cancelSubscriptions, currentPlan, deleteSubscriptionRows, NEEDS_CARD, prepareUpgrade, requirePlan, syncStripeEvent } = await import("../src/billing");
const sqlite = ((await import("void/db")) as unknown as { sqlite: { exec: (s: string) => void } }).sqlite;
const setRows = (...rows: string[]) => sqlite.exec(`delete from subscription; ${rows.map((r) => `insert into subscription (id, plan, referenceId, stripeCustomerId, stripeSubscriptionId, status) values ${r};`).join(" ")}`);
const c = () => ({ req: { raw: new Request("http://localhost/") } }) as never;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ status: 200 }), (e) => e)) as { status: number }).status;

const row = (r: Partial<SubscriptionRow>): SubscriptionRow => ({ plan: "pro", status: "active", periodEnd: new Date("2026-12-24T00:00:00Z"), trialEnd: null, cancelAtPeriodEnd: false, cancelAt: null, ...r });

it("the plan helpers: unique lookup keys, and the plugin's shape", () => {
  expect(new Set(lookupKeys()).size).toBe(lookupKeys().length);
  expect(stripePlans()[0]).toMatchObject({ name: "pro", lookupKey: "pro_monthly" });
});

it("billingView: what the Billing page shows for each status", () => {
  const cases: [SubscriptionRow[], object][] = [
    [[], { state: "none", canSubscribe: true, canManage: false }],
    [[row({ status: "incomplete" }), row({ status: "incomplete_expired" })], { state: "none", canSubscribe: true }],
    [[row({})], { state: "active", plan: "pro", date: "Dec 24, 2026", canSubscribe: false, canManage: true }],
    [[row({ cancelAtPeriodEnd: true })], { state: "cancelling", date: "Dec 24, 2026", canSubscribe: false }],
    [[row({ cancelAt: new Date("2027-01-02T00:00:00Z") })], { state: "cancelling", date: "Jan 2, 2027" }],
    [[row({ status: "trialing", trialEnd: new Date("2026-12-01T00:00:00Z") })], { state: "trialing", date: "Dec 1, 2026", canSubscribe: false }],
    [[row({}), row({ status: "past_due" })], { state: "past_due", canSubscribe: false, canManage: true }],
    [[row({ status: "unpaid" })], { state: "unpaid", canSubscribe: false, canManage: true }],
    [[row({ status: "paused" })], { state: "unpaid", canSubscribe: false, canManage: true }],
    [[row({ status: "canceled" })], { state: "canceled", canSubscribe: true, canManage: true }],
    [[row({ status: "canceled" }), row({ status: "active" })], { state: "active" }],
  ];
  for (const [rows, want] of cases) expect([rows.map((r) => r.status), billingView(rows)]).toEqual([rows.map((r) => r.status), expect.objectContaining(want)]);
});

it("a paused subscription reads as unpaid, needs a card before another Checkout, and is no plan", async () => {
  expect(billingView([row({ status: "paused" })])).toEqual(billingView([row({ status: "unpaid" })]));
  expect(NEEDS_CARD).toEqual(["past_due", "unpaid", "paused"]);
  session.user = { id: "u1" };
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'paused')`);
  expect(await status(requirePlan(c()))).toBe(403);
});

// A fake Stripe for the upgrade guard: customers.create honours the idempotency key as Stripe does; sessions are listed, then expired.
function guardClient(o: { sessions?: string[]; expireFails?: boolean; createFails?: boolean } = {}) {
  const made = new Map<string, { id: string; metadata: Record<string, string> }>(), keys: string[] = [], calls: string[] = [];
  const client = {
    customers: {
      create: async (p: { metadata: Record<string, string> }, opts: { idempotencyKey: string }) => {
        calls.push("create");
        await Promise.resolve(); // both concurrent callers are in flight before either is answered
        if (o.createFails) throw new Error("stripe down");
        keys.push(opts.idempotencyKey);
        if (!made.has(opts.idempotencyKey)) made.set(opts.idempotencyKey, { id: `cus_${made.size + 1}`, metadata: p.metadata });
        return made.get(opts.idempotencyKey)!;
      },
    },
    checkout: {
      sessions: {
        list: (p: { customer: string; status: string }) => {
          calls.push(`list ${p.customer} ${p.status}`);
          return (async function* () { for (const id of o.sessions ?? []) yield { id }; })();
        },
        expire: async (id: string) => {
          if (o.expireFails) throw new Error("stripe refused");
          calls.push(`expire ${id}`);
        },
      },
    },
  };
  return { client, made, keys, calls };
}
const guardUser = (extra: object = {}) => ({ id: "u9", email: "u9@example.com", name: "U9", ...extra });
const prepareCode = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { body?: { code?: string } }).body?.code);

it("prepareUpgrade: two first upgrades at once make one customer (one idempotency key, with metadata.userId) and store the same id", async () => {
  const { client, made, keys } = guardClient();
  const saved: string[] = [], [a, b] = [guardUser(), guardUser()];
  await Promise.all([a, b].map((u) => prepareUpgrade(client, u, async (id) => void saved.push(id))));
  expect(new Set(keys)).toEqual(new Set(["zero-stack-customer-u9"]));
  expect(keys).toHaveLength(2);
  expect([...made.values()]).toEqual([{ id: "cus_1", metadata: { userId: "u9", customerType: "user" } }]);
  expect(saved).toEqual(["cus_1", "cus_1"]);
  expect([a.stripeCustomerId, b.stripeCustomerId]).toEqual(["cus_1", "cus_1"]); // what the plugin reads next
});

it("prepareUpgrade: a user with a customer creates nothing, and every open Checkout session is expired before it returns", async () => {
  const { client, calls } = guardClient({ sessions: ["cs_1", "cs_2"] });
  await prepareUpgrade(client, guardUser({ stripeCustomerId: "cus_7" }), async () => { throw new Error("must not save"); });
  expect(calls).toEqual(["list cus_7 open", "expire cs_1", "expire cs_2"]);
});

it("prepareUpgrade: a Stripe failure fails the request with BILLING_PREPARE_FAILED, creates nothing and stores nothing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const expire = guardClient({ sessions: ["cs_1"], expireFails: true });
  expect(await prepareCode(prepareUpgrade(expire.client, guardUser({ stripeCustomerId: "cus_7" }), async () => {}))).toBe("BILLING_PREPARE_FAILED");
  expect(expire.calls).not.toContain("create");
  const create = guardClient({ createFails: true });
  const saved: string[] = [];
  expect(await prepareCode(prepareUpgrade(create.client, guardUser(), async (id) => void saved.push(id)))).toBe("BILLING_PREPARE_FAILED");
  expect([saved, create.calls]).toEqual([[], ["create"]]); // no customer stored, no session listed
});

it("requirePlan: 401 signed out, 403 without an active plan, the user with one (past_due still counts), 500 when the database is down", async () => {
  session.user = null;
  expect(await status(requirePlan(c(), "pro"))).toBe(401);
  session.user = { id: "u1" };
  setRows();
  expect(await status(requirePlan(c(), "pro"))).toBe(403);
  for (const s of ["incomplete", "canceled", "unpaid"]) {
    setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', '${s}')`);
    expect([s, await status(requirePlan(c()))]).toEqual([s, 403]);
  }
  for (const s of ["active", "trialing", "past_due"]) {
    setRows(`('s1', 'PRO', 'u1', 'cus_1', 'sub_1', '${s}')`); // names compare lowercase
    expect([s, await status(requirePlan(c(), "pro")), await currentPlan("u1")]).toEqual([s, 200, "pro"]);
  }
  expect(await status(requirePlan(c(), "other" as never))).toBe(403);
  setRows(`('s1', 'pro', 'someone-else', 'cus_2', 'sub_2', 'active')`);
  expect(await status(requirePlan(c()))).toBe(403); // another user's plan is not yours
  session.down = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await status(requirePlan(c(), "pro"))).toBe(500);
  session.down = false;
});

const key = "pro_monthly";
const event = (type: string, o: { id?: string; status?: string; customer?: string; lookup?: string; metadata?: Record<string, string> } = {}) =>
  ({
    type,
    data: { object: { id: o.id ?? "sub_1", status: o.status ?? "active", customer: o.customer ?? "cus_1", metadata: o.metadata ?? {}, items: { data: [{ price: { lookup_key: o.lookup ?? key } }] } } },
  }) as never; // the fields the sync reads, not a whole Stripe.Event
// Stripe's live state, as subscriptions.retrieve answers it.
const live = { status: "active", cancel_at_period_end: false, cancel_at: null as number | null, items: { data: [{ current_period_start: 1_790_000_000, current_period_end: 1_792_592_000, price: { lookup_key: key as string } }] } };
const retrieved: string[] = [];
const failure = { error: null as object | null }; // what subscriptions.retrieve rejects with, when set
const sync = syncStripeEvent({
  subscriptions: {
    retrieve: async (id: string) => {
      retrieved.push(id);
      if (failure.error) throw failure.error;
      return structuredClone(live) as never;
    },
  },
});
const rowOf = (id: string) => (sqlite as unknown as { prepare: (s: string) => { get: (id: string) => { plan: string; status: string; cancelAtPeriodEnd: number | null } } }).prepare("select plan, status, cancelAtPeriodEnd from subscription where id = ?").get(id);
const stored = () => { const { status, cancelAtPeriodEnd } = rowOf("s1"); return { status, cancelAtPeriodEnd }; };

it("syncStripeEvent: updated and deleted write Stripe's live state, so a retried older event can't overwrite a newer one", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  Object.assign(live, { status: "canceled" });
  await sync(event("customer.subscription.updated", { status: "active" })); // an old snapshot after the deletion
  expect(stored().status).toBe("canceled");
  Object.assign(live, { status: "past_due", cancel_at_period_end: true });
  await sync(event("customer.subscription.deleted"));
  expect(stored()).toEqual({ status: "past_due", cancelAtPeriodEnd: 1 });
  expect(retrieved).toEqual(["sub_1", "sub_1"]);
  // created never reads Stripe: the checkout's own row (found through metadata) is enough.
  setRows(`('s9', 'pro', 'u1', 'cus_1', null, 'incomplete')`);
  await sync(event("customer.subscription.created", { id: "sub_new", metadata: { subscriptionId: "s9" } }));
  expect(retrieved).toHaveLength(2);
});

it("syncStripeEvent: the plan comes from the live price, so a stale update can't bring the old plan back; an undeclared live price keeps the plan but still syncs the rest", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  Object.assign(live, { status: "active", cancel_at_period_end: false });
  live.items.data[0]!.price.lookup_key = "business_monthly"; // the user switched pro -> business in Stripe
  await sync(event("customer.subscription.updated", { lookup: key })); // a retried older event still says pro
  expect(rowOf("s1")).toMatchObject({ plan: "business", status: "active" });
  live.items.data[0]!.price.lookup_key = "not_declared";
  Object.assign(live, { status: "past_due" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync(event("customer.subscription.updated"));
  expect(rowOf("s1")).toMatchObject({ plan: "business", status: "past_due" });
  // The worst case: moved to an undeclared price, then canceled. The row must not stay active.
  Object.assign(live, { status: "canceled" });
  await sync(event("customer.subscription.deleted"));
  expect(rowOf("s1")).toMatchObject({ plan: "business", status: "canceled" });
  live.items.data[0]!.price.lookup_key = key;
});

it("syncStripeEvent: a stored subscription moved to an undeclared price in the dashboard and then cancelled ends canceled", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  const undeclared = { lookup: "not_declared" }; // every event from here on carries only the undeclared price
  live.items.data[0]!.price.lookup_key = "not_declared";
  Object.assign(live, { status: "active", cancel_at_period_end: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync(event("customer.subscription.updated", undeclared));
  expect(rowOf("s1")).toMatchObject({ plan: "pro", status: "active" });
  Object.assign(live, { status: "canceled" });
  await sync(event("customer.subscription.deleted", { ...undeclared, status: "canceled" }));
  expect(rowOf("s1")).toMatchObject({ plan: "pro", status: "canceled" });
  // One we never stored is still not ours: no throw, no Stripe read.
  retrieved.length = 0;
  for (const type of ["created", "updated", "deleted"]) await sync(event(`customer.subscription.${type}`, { ...undeclared, id: "sub_dashboard" }));
  expect(retrieved).toEqual([]);
  live.items.data[0]!.price.lookup_key = key;
});

it("syncStripeEvent: the live item is picked by declared plan, not position, so an undeclared add-on listed first doesn't block the sync", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  const plan = live.items.data[0]!;
  const addOn = { current_period_start: 1, current_period_end: 2, price: { lookup_key: "seat_addon" } };
  live.items.data = [addOn, { ...plan, price: { lookup_key: "business_monthly" } }];
  Object.assign(live, { status: "past_due", cancel_at_period_end: false });
  await sync(event("customer.subscription.updated"));
  const periodEnd = (sqlite as unknown as { prepare: (s: string) => { get: () => { periodEnd: number } } }).prepare("select periodEnd from subscription where id = 's1'").get().periodEnd;
  expect([rowOf("s1").plan, rowOf("s1").status, new Date(periodEnd).getTime()]).toEqual(["business", "past_due", plan.current_period_end * 1000]); // the plan item's period, not the add-on's
  live.items.data = [plan];
});

it("syncStripeEvent: only the row of the user who holds the event's customer is written", async () => {
  // The event is for u1's customer, but its metadata names another user's row.
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`, `('s2', 'pro', 'u2', 'cus_2', 'sub_2', 'active')`);
  Object.assign(live, { status: "canceled" });
  await sync(event("customer.subscription.updated", { metadata: { subscriptionId: "s2" } }));
  expect([rowOf("s1").status, rowOf("s2").status]).toEqual(["canceled", "active"]);
  await expect(sync(event("customer.subscription.updated", { id: "sub_2", metadata: { subscriptionId: "s2" } }))).rejects.toThrow(/was not stored/);
  expect(rowOf("s2").status).toBe("active");
});

it("syncStripeEvent: a failed Stripe read throws so Stripe retries; a subscription Stripe no longer has (404) does not", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  Object.assign(live, { status: "canceled" });
  failure.error = Object.assign(new Error("Stripe is down"), { code: "api_error", statusCode: 500 });
  await expect(sync(event("customer.subscription.updated"))).rejects.toThrow(/Stripe is down/);
  failure.error = Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync(event("customer.subscription.updated"));
  expect(rowOf("s1").status).toBe("active"); // nothing written either way
  failure.error = null;
});

it("syncStripeEvent: a lost write for a known customer throws so Stripe retries", async () => {
  setRows();
  await expect(sync(event("customer.subscription.created"))).rejects.toThrow(/was not stored/);
  await expect(sync(event("customer.subscription.updated"))).rejects.toThrow(/was not stored/);
  // Only while the write could still be in flight: an event older than an hour is logged and answered 200, so Stripe can't retry it for days.
  const at = (secondsAgo: number) => ({ ...(event("customer.subscription.updated") as object), created: Math.floor(Date.now() / 1000) - secondsAgo }) as never;
  await expect(sync(at(3000))).rejects.toThrow(/was not stored/);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(sync(at(3700))).resolves.toBeUndefined();
  expect(warn.mock.calls.at(-1)?.[0]).toMatch(/sub_1.*cus_1/);
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  Object.assign(live, { status: "unpaid" });
  session.down = true;
  await expect(sync(event("customer.subscription.updated"))).rejects.toThrow(/database down/);
  session.down = false;
});

it("syncStripeEvent: no user with the customer, undeclared prices and other events answer 200 (no throw, no Stripe call)", async () => {
  setRows();
  retrieved.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const type of ["created", "updated", "deleted"]) await sync(event(`customer.subscription.${type}`, { customer: "cus_unknown", status: "past_due" }));
  setRows(`('s1', 'pro', 'u-gone', 'cus_unknown', 'sub_1', 'active')`); // a stale row whose user is gone still never throws
  await sync(event("customer.subscription.updated", { customer: "cus_unknown", status: "past_due" }));
  setRows();
  await sync(event("customer.subscription.created", { lookup: "not_declared" }));
  await sync(event("customer.subscription.deleted"));
  await sync(event("invoice.paid"));
  expect(retrieved).toEqual([]);
});

it("cancelSubscriptions: cancels in Stripe every subscription that hasn't ended and expires open Checkout sessions, skips a user with no customer, and fails closed", async () => {
  const subs = [{ id: "sub_a", status: "active" }, { id: "sub_p", status: "past_due" }, { id: "sub_c", status: "canceled" }, { id: "sub_x", status: "incomplete_expired" }, { id: "sub_i", status: "incomplete" }];
  const calls: string[] = [];
  const state = { listFails: false, cancelFails: false, sessionsFail: false, expireFails: false };
  const client = {
    checkout: {
      sessions: {
        list: (p: { customer: string; status: string }) => {
          calls.push(`sessions ${p.customer} ${p.status}`);
          return (async function* () {
            if (state.sessionsFail) throw new Error("stripe down");
            yield { id: "cs_open" };
          })();
        },
        expire: async (id: string) => {
          if (state.expireFails) throw new Error("stripe refused");
          calls.push(`expire ${id}`);
        },
      },
    },
    subscriptions: {
      list: (p: { customer: string; status: string }) => {
        calls.push(`list ${p.customer} ${p.status}`);
        return (async function* () {
          if (state.listFails) throw new Error("stripe down");
          yield* subs;
        })();
      },
      cancel: async (id: string) => {
        if (state.cancelFails) throw new Error("stripe refused");
        calls.push(`cancel ${id}`);
      },
    },
  };
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { body?: { code?: string } }).body?.code);
  await cancelSubscriptions({}, "u1", client);
  // Sessions first: a Checkout completed meanwhile either fails its expire or has its subscription in the list that follows.
  expect(calls).toEqual(["sessions cus_1 open", "expire cs_open", "list cus_1 all", "cancel sub_a", "cancel sub_p", "cancel sub_i"]);
  calls.length = 0;
  sqlite.exec("insert into user values ('u2', 'U2', 'u2@example.com', 1, 0, 0, null)");
  await cancelSubscriptions({}, "u2", client); // never checked out: no Stripe customer, no Stripe call
  expect(calls).toEqual([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const k of ["listFails", "cancelFails", "sessionsFail", "expireFails"] as const) {
    state[k] = true;
    expect([k, await code(cancelSubscriptions({}, "u1", client))]).toEqual([k, "BILLING_CANCEL_FAILED"]);
    state[k] = false;
  }
  session.down = true; // the customer can't be read: the deletion must not go ahead unchecked
  expect(await code(cancelSubscriptions({}, "u1", client))).toBe("BILLING_CANCEL_FAILED");
  session.down = false;
  // Stripe doesn't have the customer (sandbox ids after a move to live keys): nothing to cancel, so the user can still be deleted.
  // Any other missing object still fails closed.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const missing = (param: string) => ({ ...client, checkout: { sessions: { ...client.checkout.sessions, list: () => (async function* (): AsyncGenerator<{ id: string }> { throw Object.assign(new Error("No such customer"), { code: "resource_missing", param }); })() } } });
  expect(await code(cancelSubscriptions({}, "u1", missing("customer")))).toBe("ok");
  expect(await code(cancelSubscriptions({}, "u1", missing("session")))).toBe("BILLING_CANCEL_FAILED");
});

it("cancelSubscriptions: when the second cancel fails the deletion stops, and a retry cancels only what is left", async () => {
  const subs = [{ id: "sub_a", status: "active" }, { id: "sub_p", status: "past_due" }, { id: "sub_t", status: "trialing" }];
  const calls: string[] = [];
  let failOn = "sub_p";
  const client = {
    subscriptions: {
      list: () => (async function* () { yield* subs.map((x) => ({ ...x })); })(),
      cancel: async (id: string) => {
        if (id === failOn) throw new Error("stripe refused");
        calls.push(id);
        subs.find((x) => x.id === id)!.status = "canceled"; // Stripe remembers
      },
    },
    checkout: { sessions: { list: () => (async function* () {})(), expire: async () => {} } },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(cancelSubscriptions({}, "u1", client)).rejects.toMatchObject({ body: { code: "BILLING_CANCEL_FAILED" } });
  expect(calls).toEqual(["sub_a"]); // stopped at the failure: sub_t was not reached
  failOn = "";
  await cancelSubscriptions({}, "u1", client);
  expect(calls).toEqual(["sub_a", "sub_p", "sub_t"]); // sub_a is not cancelled twice
});

it("deleteSubscriptionRows removes that user's rows only, and never throws", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'canceled')`, `('s2', 'pro', 'u1', 'cus_1', 'sub_2', 'active')`, `('s3', 'pro', 'other', 'cus_2', 'sub_3', 'active')`);
  await deleteSubscriptionRows("u1");
  const left = (sqlite as unknown as { prepare: (s: string) => { all: () => { id: string }[] } }).prepare("select id from subscription").all();
  expect(left).toEqual([{ id: "s3" }]);
  session.down = true;
  await expect(deleteSubscriptionRows("other")).resolves.toBeUndefined();
  session.down = false;
});

it("stripeClient refuses STRIPE_API_URL off this machine; the placeholder key is not configured", () => {
  for (const url of ["https://api.example.com", "http://localhost.evil.com", "not a url"]) expect(() => stripeClient("sk_test_x", url)).toThrow(/localhost/);
  expect(() => stripeClient("sk_test_x", "http://localhost:4242")).not.toThrow();
  expect(() => stripeClient(undefined)).not.toThrow(); // build time: no server env
  expect([stripeConfigured("sk_test_placeholder"), stripeConfigured(""), stripeConfigured(undefined), stripeConfigured("sk_test_real")]).toEqual([false, false, false, true]);
});
