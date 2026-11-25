// Your plans, in one place. Each plan points at its Stripe price by lookup key (never a price id), so the same code serves the sandbox and live.
// `bun run stripe:seed` creates the product and price below in the Stripe sandbox, skipping lookup keys that exist; live prices are made by the owner.
// `name` is what the app stores and checks (`requirePlan(c, "pro")`); keep it lowercase. Amounts are in the currency's smallest unit (cents).
// This file holds only the list, so an upgrade never conflicts with it. The scaffold ships one example plan and the route routes/api/example-plan.ts that
// gates on it: replace both (change the route to match), or empty the list.
import type { Plan } from "../plans";

export const PLANS = [{ name: "pro", label: "Pro", currency: "usd", monthly: { lookupKey: "pro_monthly", amount: 1000 } }] as const satisfies readonly Plan[];
