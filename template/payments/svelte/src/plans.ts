import { PLANS } from "./app/plans";

// Plans: declare them in src/app/plans.ts (this file never changes for that). This file holds the type of a plan and the helpers that read the list.
export { PLANS };
export type Plan = {
  name: string;
  label: string;
  currency: string;
  monthly: { lookupKey: string; amount: number };
  trialDays?: number; // one trial per user, ever
};

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
