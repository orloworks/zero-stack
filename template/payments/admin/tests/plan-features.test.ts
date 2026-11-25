import { expect, it, vi } from "vite-plus/test";

vi.mock("void/auth", () => ({ getUser: () => null, requireAuth: () => null }));
vi.mock("void/env", () => ({ env: { ADMIN_EMAILS: "" } }));
vi.mock("void/db", () => ({}));
// The test brings its own feature and plan, so it passes whatever the app declares (examples replaced, or the lists emptied).
vi.mock("../src/app/features", () => ({ FEATURES: ["test-feature"], PLAN_FEATURES: { "test-feature": ["pro"] } }));

const { decide, FEATURES, featuresForPlan, PLAN_FEATURES } = await import("../src/access");
const { dashboardUrl, STATUS } = await import("../src/admin-billing");

const f = FEATURES[0];
const snap = (global: "on" | "off" | "kill" | undefined, override: "on" | "off" | undefined, plan: string | null) =>
  ({ global: global ? { [f]: global } : {}, overrides: override ? { [f]: override } : {}, plan: featuresForPlan(plan) }) as never;

it("the plan source turns a feature on for its plans only, whatever the case", () => {
  expect(PLAN_FEATURES[f]).toContain("pro");
  expect(featuresForPlan("pro").has(f)).toBe(true);
  expect(featuresForPlan("PRO").has(f)).toBe(true);
  expect(featuresForPlan("free").has(f)).toBe(false);
  expect(featuresForPlan(null).size).toBe(0);
});

it("a plan feature is off without the plan, on with it, off under the kill switch, and a comped user needs no plan", () => {
  expect(decide(f, snap(undefined, undefined, null))).toBe(false);
  expect(decide(f, snap(undefined, undefined, "pro"))).toBe(true);
  expect(decide(f, snap("kill", undefined, "pro"))).toBe(false);
  expect(decide(f, snap(undefined, "on", null))).toBe(true);
  expect(decide(f, snap(undefined, "off", "pro"))).toBe(false);
});

it("a status with no date says no date", () => {
  expect(STATUS.active(null)).toBe("Active");
  expect(STATUS.trialing(null)).toBe("Free trial");
  expect(STATUS.cancelling(null)).toBe("Cancelling");
  expect(STATUS.active("Jan 1, 2027")).toBe("Active, renews on Jan 1, 2027");
});

it("the dashboard link is test mode unless the key is live", () => {
  expect(dashboardUrl("sk_test_x", "cus_1")).toBe("https://dashboard.stripe.com/test/customers/cus_1");
  expect(dashboardUrl("sk_live_x", "cus_1")).toBe("https://dashboard.stripe.com/customers/cus_1");
  expect(dashboardUrl("rk_live_x", "cus_1")).toBe("https://dashboard.stripe.com/customers/cus_1");
  expect(dashboardUrl(undefined, "cus_1")).toContain("/test/");
});
