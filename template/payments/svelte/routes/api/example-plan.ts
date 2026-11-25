import { defineHandler } from "void";
import { currentPlan, requirePlan } from "../../src/billing";

// A plan-gated route: requirePlan replaces requireAuth(c), returns the signed-in user, and answers 401 signed out or 403 without the plan.
// An example: delete this file when you replace "pro" in src/app/plans.ts.
export const GET = defineHandler(async (c) => {
  const user = await requirePlan(c, "pro");
  return c.json({ plan: await currentPlan(user.id) });
});
