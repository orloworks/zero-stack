import { expect, it, vi } from "vite-plus/test";

// Tests run in Node without Worker bindings: the session, the secret and the database are stand-ins. The database is down, so every path that needs it shows how it fails.
const session = vi.hoisted(() => ({ user: null as { id: string; email: string; emailVerified: boolean } | null }));
vi.mock("void/auth", () => ({
  getUser: () => session.user,
  requireAuth: () => {
    if (!session.user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return session.user;
  },
}));
vi.mock("void/env", () => ({ env: { ADMIN_EMAILS: "boss@example.com" } }));
// The test brings its own declarations, so it passes whatever the app declares (examples replaced, or the lists emptied). PLAN_FEATURES is read only with --payments.
vi.mock("../src/app/features", () => ({ FEATURES: ["test-feature"], PLAN_FEATURES: {} }));
vi.mock("void/db", () => {
  throw new Error("database down");
});

const access = await import("../src/access");
const { adminSwitches, decide, features, requireFeature } = access;

const c = () => ({ req: { raw: new Request("http://localhost/") } }) as never;
const status = async (p: Promise<unknown>) => ((await p.then(() => ({ status: 200 }), (e) => e)) as { status: number }).status;

it("exports exactly the access interface", () => {
  expect(Object.keys(access).sort()).toEqual(["FEATURES", "adminSwitches", "decide", "features", "requireFeature"]);
});

// Kill switch > per-user override (both directions) > plan > global > off, over every combination of the three layers.
const f = "any-feature" as never;
const snapshot = (global: "on" | "off" | "kill" | undefined, override: "on" | "off" | undefined, plan: boolean) =>
  ({ global: global ? { [f]: global } : {}, overrides: override ? { [f]: override } : {}, plan: new Set(plan ? [f] : []) }) as never;
const GLOBALS = [undefined, "on", "off", "kill"] as const;
const OVERRIDES = [undefined, "on", "off"] as const;

it("decide: precedence over every global, override and plan combination", () => {
  for (const g of GLOBALS)
    for (const o of OVERRIDES)
      for (const plan of [false, true]) {
        const want = g === "kill" ? false : o ? o === "on" : plan ? true : g === "on";
        expect([g, o, plan, decide(f, snapshot(g, o, plan))]).toEqual([g, o, plan, want]);
      }
});

it("decide: the named rules", () => {
  expect(decide(f, snapshot(undefined, undefined, false))).toBe(false); // nothing set: off
  expect(decide(f, snapshot("kill", "on", true))).toBe(false); // a kill switch beats an override on and a plan
  expect(decide(f, snapshot("on", "off", false))).toBe(false); // an override can turn a global on off
  expect(decide(f, snapshot("off", "on", false))).toBe(true); // and a global off on
  expect(decide(f, snapshot("off", undefined, true))).toBe(true); // a plan beats global
  expect(decide(f, snapshot("on", "off", true))).toBe(false); // an override beats a plan
});

it("signed out: features is the empty set and requireFeature is 401", async () => {
  session.user = null;
  expect([...(await features(c()))]).toEqual([]);
  expect(await status(requireFeature(c(), "test-feature" as never))).toBe(401);
});

it("a database error fails closed: requireFeature is 500, features is empty and never throws", async () => {
  session.user = { id: "u1", email: "u@example.com", emailVerified: true };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await status(requireFeature(c(), "test-feature" as never))).toBe(500);
  expect([...(await features(c()))]).toEqual([]);
  log.mockRestore();
});

it("adminSwitches is a 404 for anyone who is not an admin", async () => {
  session.user = { id: "u1", email: "u@example.com", emailVerified: true };
  expect(await status(adminSwitches(c()))).toBe(404);
  session.user = null;
  expect(await status(adminSwitches(c()))).toBe(404);
});
