import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { requireAuth } from "void/auth";
import { stripe } from "@better-auth/stripe";
import { lookupKeys, planForLookupKey, type PlanName, stripePlans } from "./plans";
import { PLACEHOLDER_WEBHOOK_SECRET, stripeClient, stripeConfigured } from "./stripe";

// Billing on the server. The subscription table is written by Better Auth's Stripe plugin, from Stripe's webhook and the checkout success redirect,
// and corrected here to Stripe's live state after each subscription event. Pages and routes read through this module, never the table, and never call Stripe.

type Ctx = Parameters<typeof requireAuth>[0];

// A plan counts while Stripe is still trying to collect (past_due); Stripe cancels the subscription when its retries run out.
export const ACTIVE = ["active", "trialing", "past_due"] as const;
// While one of these exists the user must fix their card in the portal, not start a second subscription.
export const NEEDS_CARD = ["past_due", "unpaid", "paused"] as const;

// void/db and the generated auth schema are imported on use: Void's plugin loads auth.ts (and so this file) at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("../.void/better-auth-schema")) });

export async function subscriptionsFor(userId: string) {
  const { db, eq, subscriptionTable } = await store();
  return db.select().from(subscriptionTable).where(eq(subscriptionTable.referenceId, userId));
}

// The user's current plan name (lowercase) or null. Reads the app's copy, never Stripe. The billing guard blocks a second Checkout, so a second
// live row can only come from a subscription made in the Stripe dashboard for the same customer; then the first row wins, here and in billingView.
// shortcut: no ordering between two live rows, upgrade when an app sells two plans and makes subscriptions in the dashboard.
export async function currentPlan(userId: string): Promise<string | null> {
  const { db, and, eq, inArray, subscriptionTable } = await store();
  const [row] = await db
    .select({ plan: subscriptionTable.plan })
    .from(subscriptionTable)
    .where(and(eq(subscriptionTable.referenceId, userId), inArray(subscriptionTable.status, [...ACTIVE])))
    .limit(1);
  return row ? row.plan.toLowerCase() : null;
}

// Gate a route or loader on a plan: replaces requireAuth(c) and returns the user. 401 signed out, 403 without an active plan (or without
// `plan` when one is named), 500 when the database can't say (an outage never grants a plan).
export async function requirePlan(c: Ctx, plan?: PlanName) {
  const user = requireAuth(c);
  let current: string | null;
  try {
    current = await currentPlan(user.id);
  } catch (e) {
    console.error("plan check failed", e);
    throw new HTTPException(500, { message: "Internal Server Error" });
  }
  if (!current || (plan && current !== (plan as string).toLowerCase())) throw new HTTPException(403, { message: "Forbidden" });
  return user;
}

// The subscription actions that call Stripe for the signed-in user.
const ACTIONS = ["/subscription/upgrade", "/subscription/billing-portal", "/subscription/cancel", "/subscription/restore"];

// Runs before the Stripe plugin's endpoints. Until real keys are set (.env ships placeholders) every subscription action answers "Stripe isn't set up yet."
// instead of a 500 from Stripe, and the webhook refuses every event (400): the placeholder secret is public, so anyone could sign with it.
// A user with a past_due, unpaid or paused subscription can't start another Checkout (the plugin's own check ignores past_due).
// Before the plugin handles an upgrade the guard makes the user's Stripe customer itself (the plugin's lookup-then-create has no lock, so two requests
// at once made two customers) and expires the customer's open Checkout sessions (two paid sessions would be two subscriptions).
export function billingGuard(opts: { configured: boolean; webhookConfigured: boolean; client: GuardClient }) {
  return {
    id: "billing-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/stripe/webhook" && !opts.webhookConfigured,
          handler: createAuthMiddleware(async () => {
            throw new APIError("BAD_REQUEST", { code: "STRIPE_WEBHOOK_NOT_CONFIGURED", message: "The Stripe webhook secret isn't set up yet." });
          }),
        },
        {
          matcher: (ctx) => ACTIONS.includes(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (!opts.configured) throw new APIError("SERVICE_UNAVAILABLE", { code: "STRIPE_NOT_CONFIGURED", message: "Stripe isn't set up yet." });
            if (ctx.path !== "/subscription/upgrade") return;
            const user = (await getSessionFromCtx(ctx))?.user;
            if (!user) return; // the endpoint answers 401
            const blocked = await ctx.context.adapter.findOne({
              model: "subscription",
              where: [
                { field: "referenceId", value: user.id },
                { field: "status", operator: "in", value: [...NEEDS_CARD] },
              ],
            });
            if (blocked)
              throw new APIError("BAD_REQUEST", { code: "SUBSCRIPTION_NEEDS_CARD", message: "Your last payment failed. Update your card in Manage billing first." });
            await prepareUpgrade(opts.client, user, (id) =>
              ctx.context.adapter.update({ model: "user", update: { stripeCustomerId: id }, where: [{ field: "id", value: user.id }] }),
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

// Everything auth.ts needs for billing: the Stripe plugin (with the one client) and the guard.
export function billingPlugins(env: BillingEnv) {
  const client = stripeClient(env.STRIPE_SECRET_KEY, env.STRIPE_API_URL);
  const secret = typeof env.STRIPE_WEBHOOK_SECRET === "string" ? env.STRIPE_WEBHOOK_SECRET : "";
  return [
    stripe({ stripeClient: client, stripeWebhookSecret: secret, subscription: { enabled: true, plans: stripePlans() }, onEvent: syncStripeEvent(client) }),
    billingGuard({ configured: stripeConfigured(env.STRIPE_SECRET_KEY), webhookConfigured: !!secret && secret !== PLACEHOLDER_WEBHOOK_SECRET, client }),
  ];
}

type BillingEnv = { STRIPE_SECRET_KEY?: unknown; STRIPE_WEBHOOK_SECRET?: unknown; STRIPE_API_URL?: unknown };
type CancelSource = {
  subscriptions: { list: (p: { customer: string; status: "all"; limit: number }) => AsyncIterable<{ id: string; status: string }>; cancel: (id: string) => Promise<unknown> };
  checkout: { sessions: { list: (p: { customer: string; status: "open"; limit: number }) => AsyncIterable<{ id: string }>; expire: (id: string) => Promise<unknown> } };
};

type GuardClient = Pick<CancelSource, "checkout"> & {
  customers: { create: (p: { email: string; name: string; metadata: Record<string, string> }, o: { idempotencyKey: string }) => Promise<{ id: string }> };
};
type GuardUser = { id: string; email: string; name: string; stripeCustomerId?: string | null };

const expireOpenSessions = async (client: Pick<CancelSource, "checkout">, customer: string) => {
  for await (const open of client.checkout.sessions.list({ customer, status: "open", limit: 100 })) await client.checkout.sessions.expire(open.id);
};

// The guard's work before /subscription/upgrade (the save callback stores the customer id on the user). The customer is created as the plugin would
// (metadata.userId, customerType user) but under an idempotency key from the user id, so concurrent or retried first upgrades get one customer; the
// id is also set on the session user, which the plugin reads next. Then every open Checkout session of the customer is expired. Fails closed
// (500 BILLING_PREPARE_FAILED): a failed customer create or expire never lets the plugin go on to a second customer or a second open Checkout.
// shortcut: two upgrades racing past this point can still leave two open sessions, upgrade when Stripe offers a lock or the app takes a database one.
export async function prepareUpgrade(client: GuardClient, user: GuardUser, save: (customerId: string) => Promise<unknown>): Promise<void> {
  try {
    if (!user.stripeCustomerId) {
      const created = await client.customers.create(
        { email: user.email, name: user.name, metadata: { userId: user.id, customerType: "user" } },
        { idempotencyKey: `zero-stack-customer-${user.id}` },
      );
      await save(created.id);
      user.stripeCustomerId = created.id;
    }
    await expireOpenSessions(client, user.stripeCustomerId);
  } catch (e) {
    console.error(`upgrade preparation failed for ${user.id}`, e);
    throw new APIError("INTERNAL_SERVER_ERROR", { code: "BILLING_PREPARE_FAILED", message: "Couldn't reach Stripe to start the checkout. Try again." });
  }
}

// Runs before a user is deleted, on both paths and ahead of the storage purge: auth.ts's deleteUser.beforeDelete and the admin guard's remove-user hook.
// It expires the customer's open Checkout sessions first (one paid after the deletion would start a subscription nobody owns), then asks Stripe,
// not the table, for the customer's subscriptions (a past_due one, or one whose webhook hasn't arrived, must end too) and cancels each that hasn't
// ended. Sessions go first so a Checkout completed meanwhile is caught: its expire fails (retry), or its subscription is already in the list.
// Fails closed: a deleted user who keeps being billed is worse than a failed deletion. No Stripe customer, or one Stripe doesn't have
// (the app moved from sandbox to live keys, or the customer was deleted in Stripe): nothing to cancel, so the deletion goes ahead.
export async function cancelSubscriptions(env: BillingEnv, userId: string, client: CancelSource = stripeClient(env.STRIPE_SECRET_KEY, env.STRIPE_API_URL)): Promise<void> {
  try {
    const { db, eq, userTable } = await store();
    const [user] = await db.select({ customer: userTable.stripeCustomerId }).from(userTable).where(eq(userTable.id, userId)).limit(1);
    if (!user?.customer) return;
    await expireOpenSessions(client, user.customer);
    for await (const sub of client.subscriptions.list({ customer: user.customer, status: "all", limit: 100 }))
      if (sub.status !== "canceled" && sub.status !== "incomplete_expired") await client.subscriptions.cancel(sub.id);
  } catch (e) {
    const err = e as { code?: string; param?: string } | null;
    if (err?.code === "resource_missing" && err.param === "customer") return console.warn(`no Stripe customer for ${userId}; nothing to cancel`);
    console.error(`subscription cancel failed for ${userId}`, e);
    throw new APIError("INTERNAL_SERVER_ERROR", { code: "BILLING_CANCEL_FAILED", message: "Couldn't cancel the subscription in Stripe, so the account was not deleted. Try again." });
  }
}

// After the user is deleted (databaseHooks.user.delete.after): the plugin's rows have no foreign key, so they don't cascade. Never throws: the user is already gone.
export async function deleteSubscriptionRows(userId: string): Promise<void> {
  try {
    const { db, eq, subscriptionTable } = await store();
    await db.delete(subscriptionTable).where(eq(subscriptionTable.referenceId, userId));
  } catch (e) {
    console.error(`subscription rows not deleted for ${userId}`, e);
  }
}

type LiveSource = { subscriptions: { retrieve: (id: string) => Promise<Stripe.Subscription> } };

// The plugin's onEvent, called after it handled the event. Two gaps it leaves: it catches its own database errors and still answers 200 (a lost
// write is never retried), and it writes each event's snapshot as it arrives, so a retried older event can overwrite a newer state.
//   created: the row must exist (the checkout's own row counts); else throw so Stripe retries.
//   updated, deleted: read the live subscription from Stripe and, if the row differs, write the live state (plan, status, cancellation, period);
//     a failed read or write throws (retried). A subscription Stripe no longer has (resource_missing) leaves nothing to sync: 200.
// Only the row of the user who holds the event's customer is read or written, whatever row the event's metadata names.
// Nothing throws when no user holds the event's customer (made in the dashboard, or the user was deleted with their rows): a retry could never
// store it, and Stripe would retry for days and then disable the endpoint. A subscription on an undeclared price is left to the plugin's log.
// For the same reason a missing row throws only for an event under an hour old.
export const syncStripeEvent = (client: LiveSource) => async (event: Stripe.Event): Promise<void> => {
  if (event.type !== "customer.subscription.created" && event.type !== "customer.subscription.updated" && event.type !== "customer.subscription.deleted") return;
  const sub = event.data.object;
  const keys = lookupKeys();
  // An event with no declared price is ours only if we already hold a row for the subscription (moved to an undeclared price in the dashboard):
  // its status must still follow Stripe. One we never stored is not ours.
  const declared = sub.items.data.some((i) => !!i.price.lookup_key && keys.includes(i.price.lookup_key));
  if (!declared && event.type === "customer.subscription.created") return;
  const { db, and, eq, or, subscriptionTable, userTable } = await store();
  // No user holds this customer (made in the dashboard, or the user was deleted with their rows): a retry can never store it, and Stripe would
  // retry for days and then disable the endpoint. Log it and answer 200.
  const [owner] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.stripeCustomerId, String(sub.customer))).limit(1);
  if (!owner) {
    if (declared) console.warn(`stripe ${event.type} for ${sub.id}: no user has customer ${String(sub.customer)}; ignored`);
    return;
  }
  const metaId = sub.metadata?.subscriptionId;
  const byStripeId = eq(subscriptionTable.stripeSubscriptionId, sub.id);
  const mine = eq(subscriptionTable.referenceId, owner.id);
  const [row] = await db.select().from(subscriptionTable).where(and(mine, metaId ? or(eq(subscriptionTable.id, metaId), byStripeId) : byStripeId)).limit(1);
  if (!row) {
    // A deletion for a row we never had leaves nothing to fix; a retry could not change that.
    if (!declared || event.type === "customer.subscription.deleted") return;
    // Throw (Stripe retries) only while the row's write could still be in flight. After an hour it never will be, and Stripe would retry for days.
    if (event.created < Date.now() / 1000 - 3600) {
      console.warn(`stripe ${event.type} ${event.id} for ${sub.id}: customer ${String(sub.customer)} (user ${owner.id}) has no row for it after an hour; ignored`);
      return;
    }
    throw new Error(`subscription ${sub.id} for a known customer was not stored`);
  }
  // created: the plugin skips a row the checkout already made; its status comes from checkout.session.completed or the next update.
  if (event.type === "customer.subscription.created") return;
  let live: Stripe.Subscription;
  try {
    live = await client.subscriptions.retrieve(sub.id);
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== "resource_missing") throw e;
    console.warn(`stripe ${event.type} for ${sub.id}: Stripe no longer has it; nothing to sync`);
    return;
  }
  // The plan's item, wherever it sits: an undeclared add-on can be listed first.
  const item = live.items.data.find((i) => planForLookupKey(i.price.lookup_key)) ?? live.items.data[0];
  // The plan comes from the live price, not the event's: a retried older event must not bring an old plan back.
  // No declared plan on the live subscription: the row keeps its plan, but its status still follows Stripe, so a canceled one can't stay active.
  const plan = planForLookupKey(item?.price.lookup_key);
  if (!plan) console.warn(`stripe ${event.type} for ${sub.id}: its live price is not a declared plan; the plan stays ${row.plan}`);
  const state = {
    ...(plan && { plan: plan.name.toLowerCase() }),
    status: live.status,
    cancelAtPeriodEnd: live.cancel_at_period_end,
    cancelAt: live.cancel_at ? new Date(live.cancel_at * 1000) : null,
    ...(item && { periodStart: new Date(item.current_period_start * 1000), periodEnd: new Date(item.current_period_end * 1000) }),
  };
  const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);
  const same =
    (!state.plan || row.plan === state.plan) &&
    row.status === state.status &&
    !!row.cancelAtPeriodEnd === state.cancelAtPeriodEnd &&
    time(row.cancelAt) === time(state.cancelAt) &&
    (!item || time(row.periodEnd) === time(state.periodEnd));
  if (same) return;
  await db.update(subscriptionTable).set(state).where(and(mine, eq(subscriptionTable.id, row.id)));
};
