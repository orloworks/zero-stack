import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { requireAuth } from "void/auth";
import { stripe } from "@better-auth/stripe";
import { lookupKeys, type PlanName, stripePlans } from "./plans";
import { PLACEHOLDER_WEBHOOK_SECRET, stripeClient, stripeConfigured } from "./stripe";

// Billing on the server. The subscription table is written by Better Auth's Stripe plugin, from Stripe's webhook and the checkout success redirect,
// and corrected here to Stripe's live state after each subscription event. Pages and routes read through this module, never the table, and never call Stripe.

type Ctx = Parameters<typeof requireAuth>[0];

// A plan counts while Stripe is still trying to collect (past_due); Stripe cancels the subscription when its retries run out.
export const ACTIVE = ["active", "trialing", "past_due"] as const;
// While one of these exists the user must fix their card in the portal, not start a second subscription.
export const NEEDS_CARD = ["past_due", "unpaid"] as const;

// void/db and the generated auth schema are imported on use: Void's plugin loads auth.ts (and so this file) at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("../.void/better-auth-schema")) });

export async function subscriptionsFor(userId: string) {
  const { db, eq, subscriptionTable } = await store();
  return db.select().from(subscriptionTable).where(eq(subscriptionTable.referenceId, userId));
}

// The user's current plan name (lowercase) or null. Reads the app's copy, never Stripe.
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
  if (!current || (plan && current !== plan.toLowerCase())) throw new HTTPException(403, { message: "Forbidden" });
  return user;
}

// The subscription actions that call Stripe for the signed-in user.
const ACTIONS = ["/subscription/upgrade", "/subscription/billing-portal", "/subscription/cancel", "/subscription/restore"];

// Runs before the Stripe plugin's endpoints. Until real keys are set (.env ships placeholders) every subscription action answers "Stripe isn't set up yet."
// instead of a 500 from Stripe, and the webhook refuses every event (400): the placeholder secret is public, so anyone could sign with it.
// A user with a past_due or unpaid subscription can't start another Checkout (the plugin's own check ignores past_due).
export function billingGuard(opts: { configured: boolean; webhookConfigured: boolean }) {
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
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

// Everything auth.ts needs for billing: the Stripe plugin (with the one client) and the guard.
export function billingPlugins(env: { STRIPE_SECRET_KEY?: unknown; STRIPE_WEBHOOK_SECRET?: unknown; STRIPE_API_URL?: unknown }) {
  const client = stripeClient(env.STRIPE_SECRET_KEY, env.STRIPE_API_URL);
  const secret = typeof env.STRIPE_WEBHOOK_SECRET === "string" ? env.STRIPE_WEBHOOK_SECRET : "";
  return [
    stripe({ stripeClient: client, stripeWebhookSecret: secret, subscription: { enabled: true, plans: stripePlans() }, onEvent: syncStripeEvent(client) }),
    billingGuard({ configured: stripeConfigured(env.STRIPE_SECRET_KEY), webhookConfigured: !!secret && secret !== PLACEHOLDER_WEBHOOK_SECRET }),
  ];
}

type LiveSource = { subscriptions: { retrieve: (id: string) => Promise<Stripe.Subscription> } };

// The plugin's onEvent, called after it handled the event. Two gaps it leaves: it catches its own database errors and still answers 200 (a lost
// write is never retried), and it writes each event's snapshot as it arrives, so a retried older event can overwrite a newer state.
//   created: the row must exist (the checkout's own row counts); else throw so Stripe retries.
//   updated, deleted: read the live subscription from Stripe and, if the row differs, write the live state; a failed write or read throws (retried).
// Nothing throws when no user holds the event's customer (made in the dashboard, or the user was deleted with their rows): a retry could never
// store it, and Stripe would retry for days and then disable the endpoint. A subscription on an undeclared price is left to the plugin's log.
export const syncStripeEvent = (client: LiveSource) => async (event: Stripe.Event): Promise<void> => {
  if (event.type !== "customer.subscription.created" && event.type !== "customer.subscription.updated" && event.type !== "customer.subscription.deleted") return;
  const sub = event.data.object;
  const keys = lookupKeys();
  if (!sub.items.data.some((i) => !!i.price.lookup_key && keys.includes(i.price.lookup_key))) return;
  const { db, eq, or, subscriptionTable, userTable } = await store();
  // No user holds this customer (made in the dashboard, or the user was deleted with their rows): a retry can never store it, and Stripe would
  // retry for days and then disable the endpoint. Log it and answer 200.
  const [owner] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.stripeCustomerId, String(sub.customer))).limit(1);
  if (!owner) {
    console.warn(`stripe ${event.type} for ${sub.id}: no user has customer ${String(sub.customer)}; ignored`);
    return;
  }
  const metaId = sub.metadata?.subscriptionId;
  const byStripeId = eq(subscriptionTable.stripeSubscriptionId, sub.id);
  const [row] = await db.select().from(subscriptionTable).where(metaId ? or(eq(subscriptionTable.id, metaId), byStripeId) : byStripeId).limit(1);
  if (!row) {
    // A deletion for a row we never had leaves nothing to fix; a retry could not change that.
    if (event.type === "customer.subscription.deleted") return;
    throw new Error(`subscription ${sub.id} for a known customer was not stored`);
  }
  // created: the plugin skips a row the checkout already made; its status comes from checkout.session.completed or the next update.
  if (event.type === "customer.subscription.created") return;
  const live = await client.subscriptions.retrieve(sub.id);
  const item = live.items.data[0];
  const state = {
    status: live.status,
    cancelAtPeriodEnd: live.cancel_at_period_end,
    cancelAt: live.cancel_at ? new Date(live.cancel_at * 1000) : null,
    ...(item && { periodStart: new Date(item.current_period_start * 1000), periodEnd: new Date(item.current_period_end * 1000) }),
  };
  const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : null);
  const same =
    row.status === state.status &&
    !!row.cancelAtPeriodEnd === state.cancelAtPeriodEnd &&
    time(row.cancelAt) === time(state.cancelAt) &&
    (!item || time(row.periodEnd) === time(state.periodEnd));
  if (same) return;
  await db.update(subscriptionTable).set(state).where(eq(subscriptionTable.id, row.id));
};
