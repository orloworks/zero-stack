// What the Billing page shows, from the user's subscription rows. Pure: the loader passes rows in, the page renders the result.
export type SubscriptionRow = {
  plan: string;
  status: string;
  periodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  cancelAt: Date | null;
};

export type BillingState = "none" | "active" | "trialing" | "cancelling" | "past_due" | "unpaid" | "canceled";
export type BillingView = { state: BillingState; plan: string | null; date: string | null; canSubscribe: boolean; canManage: boolean };

const day = (d: Date | null) => (d ? new Date(d).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" }) : null);

// One row decides, in this order: a failed payment (the user must act), a live plan, then an ended one. incomplete and incomplete_expired
// are a Checkout that never finished and count as no plan. Subscribe shows only with no live or failed plan.
export function billingView(rows: SubscriptionRow[], label: (plan: string) => string = (p) => p): BillingView {
  const find = (...statuses: string[]) => rows.find((r) => statuses.includes(r.status));
  const row = find("past_due", "unpaid", "paused") ?? find("active", "trialing") ?? find("canceled");
  if (!row) return { state: "none", plan: null, date: null, canSubscribe: true, canManage: false };
  const plan = label(row.plan);
  const base = { plan, canSubscribe: false, canManage: true };
  if (row.status === "past_due") return { ...base, state: "past_due", date: null };
  if (row.status === "unpaid" || row.status === "paused") return { ...base, state: "unpaid", date: null }; // a paused subscription reads as unpaid: fix the card
  if (row.status === "canceled") return { ...base, state: "canceled", date: null, canSubscribe: true };
  if (row.cancelAtPeriodEnd || row.cancelAt) return { ...base, state: "cancelling", date: day(row.cancelAt ?? row.periodEnd) };
  if (row.status === "trialing") return { ...base, state: "trialing", date: day(row.trialEnd ?? row.periodEnd) };
  return { ...base, state: "active", date: day(row.periodEnd) };
}
