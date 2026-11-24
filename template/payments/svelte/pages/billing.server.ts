import { defineHandler, type InferProps } from "void";
import { getUser } from "void/auth";
import { env } from "void/env";
import { subscriptionsFor } from "../src/billing";
import { billingView } from "../src/lib/billing-view";
import { type Plan, planNamed, PLANS } from "../src/plans";
import { stripeConfigured } from "../src/stripe";

export type Props = InferProps<typeof loader>;

// Reads the subscription table, not the plugin's list endpoint, which returns only active and trialing plans (a past_due user must see the failure).
export const loader = defineHandler(async () => {
  const user = getUser();
  const configured = stripeConfigured(env.STRIPE_SECRET_KEY);
  const plans = (PLANS as readonly Plan[]).map((p) => ({ name: p.name, label: p.label, currency: p.currency, monthly: p.monthly.amount, annual: p.annual?.amount ?? null }));
  if (!user) return { user: null, configured, plans, view: null };
  const view = billingView(await subscriptionsFor(user.id), (name) => planNamed(name)?.label ?? name);
  return { user: { email: user.email }, configured, plans, view };
});
