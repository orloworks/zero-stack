// Your plans, in one place. Each plan points at its Stripe price by lookup key (never a price id), so the same code serves the sandbox and live.
// `bun run stripe:seed` creates the product and price below in the Stripe sandbox, skipping lookup keys that exist; live prices are made by the owner.
// `name` is what the app stores and checks (`requirePlan(c, "pro")`); keep it lowercase. Amounts are in the currency's smallest unit (cents).
// The scaffold ships one example plan: replace it.
export type Plan = {
  name: string;
  label: string;
  currency: string;
  monthly: { lookupKey: string; amount: number };
  trialDays?: number; // one trial per user, ever
};

export const PLANS = [{ name: "pro", label: "Pro", currency: "usd", monthly: { lookupKey: "pro_monthly", amount: 1000 } }] as const satisfies readonly Plan[];

export type PlanName = (typeof PLANS)[number]["name"];

const all: readonly Plan[] = PLANS;
export const planNamed = (name: string): Plan | undefined => all.find((p) => p.name === name.toLowerCase());

// Every lookup key a declared plan uses.
export const lookupKeys = (): string[] => all.map((p) => p.monthly.lookupKey);

// The declared plan a Stripe price belongs to, by its lookup key.
export const planForLookupKey = (key: string | null | undefined): Plan | undefined => (key ? all.find((p) => p.monthly.lookupKey === key) : undefined);

// The plans in the shape Better Auth's Stripe plugin takes.
export const stripePlans = () =>
  all.map((p) => ({ name: p.name, lookupKey: p.monthly.lookupKey, ...(p.trialDays && { freeTrial: { days: p.trialDays } }) }));
