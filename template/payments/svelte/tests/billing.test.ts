import { expect, it, vi } from "vite-plus/test";
import { billingView, type SubscriptionRow } from "../src/lib/billing-view";
import { lookupKeys, PLANS, stripePlans } from "../src/plans";
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

// A second declared plan, "business", beside whatever src/plans.ts declares, so a plan change can be tested.
vi.mock("../src/plans", async (original) => {
  const real = await original<typeof import("../src/plans")>();
  const business = { name: "business", label: "Business", currency: "usd", monthly: { lookupKey: "business_monthly", amount: 5000 } };
  return {
    ...real,
    lookupKeys: () => [...real.lookupKeys(), business.monthly.lookupKey],
    planForLookupKey: (k: string | null | undefined) => (k === business.monthly.lookupKey ? business : real.planForLookupKey(k)),
  };
});

const { cancelSubscriptions, currentPlan, deleteSubscriptionRows, requirePlan, syncStripeEvent } = await import("../src/billing");
const sqlite = ((await import("void/db")) as unknown as { sqlite: { exec: (s: string) => void } }).sqlite;
const setRows = (...rows: string[]) => sqlite.exec(`delete from subscription; ${rows.map((r) => `insert into subscription (id, plan, referenceId, stripeCustomerId, stripeSubscriptionId, status) values ${r};`).join(" ")}`);
const c = () => ({ req: { raw: new Request("http://localhost/") } }) as never;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ status: 200 }), (e) => e)) as { status: number }).status;

const row = (r: Partial<SubscriptionRow>): SubscriptionRow => ({ plan: "pro", status: "active", periodEnd: new Date("2026-12-24T00:00:00Z"), trialEnd: null, cancelAtPeriodEnd: false, cancelAt: null, ...r });

it("the plan declaration: lowercase names, unique lookup keys, and the plugin's shape", () => {
  for (const p of PLANS) expect(p.name).toBe(p.name.toLowerCase());
  expect(new Set(lookupKeys()).size).toBe(lookupKeys().length);
  expect(stripePlans()[0]).toMatchObject({ name: PLANS[0].name, lookupKey: PLANS[0].monthly.lookupKey });
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
    [[row({ status: "canceled" })], { state: "canceled", canSubscribe: true, canManage: true }],
    [[row({ status: "canceled" }), row({ status: "active" })], { state: "active" }],
  ];
  for (const [rows, want] of cases) expect([rows.map((r) => r.status), billingView(rows)]).toEqual([rows.map((r) => r.status), expect.objectContaining(want)]);
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

const key = PLANS[0].monthly.lookupKey;
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

it("syncStripeEvent: the plan comes from the live price, so a stale update can't bring the old plan back; an undeclared live price is skipped", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  Object.assign(live, { status: "active", cancel_at_period_end: false });
  live.items.data[0]!.price.lookup_key = "business_monthly"; // the user switched pro -> business in Stripe
  await sync(event("customer.subscription.updated", { lookup: key })); // a retried older event still says pro
  expect(rowOf("s1")).toMatchObject({ plan: "business", status: "active" });
  live.items.data[0]!.price.lookup_key = "not_declared";
  Object.assign(live, { status: "past_due" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await sync(event("customer.subscription.updated"));
  expect(rowOf("s1")).toMatchObject({ plan: "business", status: "active" });
  live.items.data[0]!.price.lookup_key = key;
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

it("cancelSubscriptions: cancels in Stripe every subscription that hasn't ended, skips a user with no customer, and fails closed", async () => {
  const subs = [{ id: "sub_a", status: "active" }, { id: "sub_p", status: "past_due" }, { id: "sub_c", status: "canceled" }, { id: "sub_x", status: "incomplete_expired" }, { id: "sub_i", status: "incomplete" }];
  const calls: string[] = [];
  const state = { listFails: false, cancelFails: false };
  const client = {
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
  expect(calls).toEqual(["list cus_1 all", "cancel sub_a", "cancel sub_p", "cancel sub_i"]);
  calls.length = 0;
  sqlite.exec("insert into user values ('u2', 'U2', 'u2@example.com', 1, 0, 0, null)");
  await cancelSubscriptions({}, "u2", client); // never checked out: no Stripe customer, no Stripe call
  expect(calls).toEqual([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const k of ["listFails", "cancelFails"] as const) {
    state[k] = true;
    expect([k, await code(cancelSubscriptions({}, "u1", client))]).toEqual([k, "BILLING_CANCEL_FAILED"]);
    state[k] = false;
  }
  session.down = true; // the customer can't be read: the deletion must not go ahead unchecked
  expect(await code(cancelSubscriptions({}, "u1", client))).toBe("BILLING_CANCEL_FAILED");
  session.down = false;
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
