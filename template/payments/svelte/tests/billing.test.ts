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

const { confirmStripeEvent, currentPlan, requirePlan } = await import("../src/billing");
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
const event = (type: string, o: { id?: string; status?: string; customer?: string; lookup?: string; metadata?: Record<string, string> } = {}) => ({
  type,
  data: { object: { id: o.id ?? "sub_1", status: o.status ?? "active", customer: o.customer ?? "cus_1", metadata: o.metadata ?? {}, items: { data: [{ price: { lookup_key: o.lookup ?? key } }] } } },
}) as never; // the fields the check reads, not a whole Stripe.Event

it("confirmStripeEvent: a stored row that matches the event passes; a missed write throws so Stripe retries", async () => {
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'active')`);
  await confirmStripeEvent(event("customer.subscription.updated", { status: "active" }));
  await expect(confirmStripeEvent(event("customer.subscription.updated", { status: "past_due" }))).rejects.toThrow(/stored status active/);
  await expect(confirmStripeEvent(event("customer.subscription.deleted"))).rejects.toThrow(/event says canceled/);
  setRows(`('s1', 'pro', 'u1', 'cus_1', 'sub_1', 'canceled')`);
  await confirmStripeEvent(event("customer.subscription.deleted"));
  // created: the checkout's own row (found through metadata) is enough; its status comes later.
  setRows(`('s9', 'pro', 'u1', 'cus_1', null, 'incomplete')`);
  await confirmStripeEvent(event("customer.subscription.created", { id: "sub_new", metadata: { subscriptionId: "s9" } }));
  // No row for a known customer: the write was lost.
  setRows();
  await expect(confirmStripeEvent(event("customer.subscription.created"))).rejects.toThrow(/was not stored/);
  await expect(confirmStripeEvent(event("customer.subscription.updated"))).rejects.toThrow(/was not stored/);
});

it("confirmStripeEvent: no user with the customer, undeclared prices and other events answer 200 (no throw)", async () => {
  setRows();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const type of ["created", "updated", "deleted"]) await confirmStripeEvent(event(`customer.subscription.${type}`, { customer: "cus_unknown", status: "past_due" }));
  setRows(`('s1', 'pro', 'u-gone', 'cus_unknown', 'sub_1', 'active')`); // a stale row whose user is gone still never throws
  await confirmStripeEvent(event("customer.subscription.updated", { customer: "cus_unknown", status: "past_due" }));
  setRows();
  await confirmStripeEvent(event("customer.subscription.created", { lookup: "not_declared" }));
  await confirmStripeEvent(event("customer.subscription.deleted"));
  await confirmStripeEvent(event("invoice.paid"));
});

it("stripeClient refuses STRIPE_API_URL off this machine; the placeholder key is not configured", () => {
  for (const url of ["https://api.example.com", "http://localhost.evil.com", "not a url"]) expect(() => stripeClient("sk_test_x", url)).toThrow(/localhost/);
  expect(() => stripeClient("sk_test_x", "http://localhost:4242")).not.toThrow();
  expect(() => stripeClient(undefined)).not.toThrow(); // build time: no server env
  expect([stripeConfigured("sk_test_placeholder"), stripeConfigured(""), stripeConfigured(undefined), stripeConfigured("sk_test_real")]).toEqual([false, false, false, true]);
});
