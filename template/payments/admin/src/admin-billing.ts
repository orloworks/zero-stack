import { subscriptionsFor } from "./billing";
import { type BillingState, billingView } from "./lib/billing-view";
import { planNamed } from "./plans";

// The Stripe dashboard shows a test-mode customer under /test. The mode comes from the key's prefix; only the URL leaves the server, never the key.
export const dashboardUrl = (key: unknown, customerId: string): string =>
  `https://dashboard.stripe.com/${typeof key === "string" && /^[sr]k_live_/.test(key) ? "" : "test/"}customers/${encodeURIComponent(customerId)}`;

export const STATUS: Record<Exclude<BillingState, "none">, (date: string | null) => string> = {
  active: (d) => (d ? `Active, renews on ${d}` : "Active"),
  trialing: (d) => (d ? `Free trial, ends on ${d}` : "Free trial"),
  cancelling: (d) => (d ? `Cancelling, ends on ${d}` : "Cancelling"),
  past_due: () => "Past due: the last payment failed",
  unpaid: () => "Unpaid: payments failed and the plan is paused",
  canceled: () => "Canceled",
};

// What the admin user page shows: the same view as the user's Billing page, plus a link to their customer in Stripe (null before their first checkout).
export async function adminBilling(userId: string, key: unknown) {
  const { db, eq, userTable } = { ...(await import("void/db")), ...(await import("../.void/better-auth-schema")) };
  const [row] = await db.select({ customer: userTable.stripeCustomerId }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  const view = billingView(await subscriptionsFor(userId), (name) => planNamed(name)?.label ?? name);
  return { plan: view.plan, status: view.state === "none" ? null : STATUS[view.state](view.date), customerUrl: row?.customer ? dashboardUrl(key, row.customer) : null };
}
