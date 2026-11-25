import { HTTPException } from "hono/http-exception";
import { getUser, requireAuth } from "void/auth";
import { auditRow, findUser, requireAdmin } from "./admin";
import { FEATURES } from "./app/features";

// Feature switches. Declare a feature by adding its name to FEATURES in src/app/features.ts (this file never changes for that); gate a route with `await requireFeature(c, "name")` (it replaces requireAuth(c) and returns the
// user: 401 signed out, 403 when the feature is off for them); read `await features(c)` in a loader to show or hide UI. An admin sets each feature on, off or kill switch on
// the Features page and overrides it per user on user detail.
export { FEATURES };
export type Feature = (typeof FEATURES)[number];

type Ctx = Parameters<typeof requireAuth>[0];
type State = "on" | "off" | "kill";
type Override = "on" | "off";
type Snapshot = { global: Partial<Record<Feature, State>>; overrides: Partial<Record<Feature, Override>>; plan: ReadonlySet<Feature> };

const STATES: readonly State[] = ["on", "off", "kill"];
const OVERRIDES: readonly Override[] = ["on", "off"];

// The one precedence rule, with the reason an admin sees: kill switch > per-user override (both directions) > plan > global > off.
function resolve(f: Feature, s: Snapshot): { on: boolean; reason: string } {
  if (s.global[f] === "kill") return { on: false, reason: "Off: kill switch applies to everyone" };
  const o = s.overrides[f];
  if (o) return { on: o === "on", reason: o === "on" ? "On: user override" : "Off: user override" };
  if (s.plan.has(f)) return { on: true, reason: "On: included in the user's plan" };
  return s.global[f] === "on" ? { on: true, reason: "On: on for everyone" } : { on: false, reason: "Off: off for everyone" };
}

// Pure. The gate and the admin pages both use it, so a page never disagrees with a route.
export const decide = (f: Feature, s: Snapshot): boolean => resolve(f, s).on;

// Where plans grant features. Empty until --payments adds a source: each returns the features a user's plan includes.
const sources: ((userId: string) => Promise<ReadonlySet<Feature>>)[] = [];

// void/db and @schema are imported on use: Void's plugin loads auth.ts at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")) });

const declared = (name: string): name is Feature => (FEATURES as readonly string[]).includes(name);
const pick = <T extends string>(allowed: readonly T[], v: unknown): T | undefined => allowed.find((a) => a === v);

// Rows for features that are no longer declared, or with a value nobody wrote through set(), are dropped.
async function load(userId: string | null): Promise<Snapshot> {
  const { db, eq, featureSwitch, featureOverride } = await store();
  const [switches, overrides, plans] = await Promise.all([
    db.select().from(featureSwitch),
    userId ? db.select().from(featureOverride).where(eq(featureOverride.userId, userId)) : [],
    Promise.all(sources.map((s) => (userId ? s(userId) : new Set<Feature>()))),
  ]);
  const snap: Snapshot = { global: {}, overrides: {}, plan: new Set(plans.flatMap((p) => [...p])) };
  for (const r of switches) if (declared(r.feature) && pick(STATES, r.state)) snap.global[r.feature] = r.state as State;
  for (const r of overrides) if (declared(r.feature) && pick(OVERRIDES, r.state)) snap.overrides[r.feature] = r.state as Override;
  return snap;
}

// One snapshot per request, memoised on the raw request, so several checks in a request cost one read.
const memo = new WeakMap<Request, Promise<Snapshot>>();
const mine = (c: Ctx, userId: string) => {
  const raw = c.req.raw;
  const hit = memo.get(raw);
  if (hit) return hit;
  const fresh = load(userId);
  memo.set(raw, fresh);
  return fresh;
};

// Signed out: the empty set. A failed read is the empty set too (closed, logged): this never throws.
export async function features(c: Ctx): Promise<ReadonlySet<Feature>> {
  const user = getUser();
  if (!user) return new Set();
  try {
    const snap = await mine(c, user.id);
    return new Set(FEATURES.filter((f) => decide(f, snap)));
  } catch (e) {
    console.error("feature check failed", e);
    return new Set();
  }
}

// 401 signed out, 403 when the feature is off for this user, 500 when the database can't say (an outage never turns a feature on).
export async function requireFeature(c: Ctx, f: Feature) {
  const user = requireAuth(c);
  let snap: Snapshot;
  try {
    snap = await mine(c, user.id);
  } catch (e) {
    console.error("feature check failed", e);
    throw new HTTPException(500, { message: "Internal Server Error" });
  }
  if (!decide(f, snap)) throw new HTTPException(403, { message: "Forbidden" });
  return user;
}

type Result = { ok: true } | { ok: false; status: 400 | 404; message: string };
const refuse = (status: 400 | 404, message: string): Result => ({ ok: false, status, message });

// Admin only (404 for anyone else). `userId` adds that user's overrides, so `effective` is what that user gets; without it, `effective` is what a user with no override gets.
// `set` is bound to the admin who called this: it writes the change and its audit entry in one db.batch, so a change is never unrecorded.
// A change is { feature, state } for the global switch ("on" | "off" | "kill") or { feature, userId, state } for an override ("on" | "off" | "default").
export async function adminSwitches(c: Ctx, userId?: string) {
  const actor = requireAdmin(c);
  const snap = await load(userId ?? null);
  return {
    global: snap.global,
    overrides: snap.overrides,
    effective: (f: Feature) => resolve(f, snap),
    async set(change: { feature: string; userId?: string; state: unknown }): Promise<Result> {
      const feature = change.feature;
      if (!declared(feature)) return refuse(400, "That feature is not declared in src/app/features.ts.");
      const { db, and, eq, featureSwitch, featureOverride, auditEntry } = await store();
      const now = new Date();
      if (change.userId === undefined) {
        const state = pick(STATES, change.state);
        if (!state) return refuse(400, "Choose on, off or kill switch.");
        const old = (await db.select().from(featureSwitch).where(eq(featureSwitch.feature, feature)).limit(1))[0]?.state ?? "off";
        await db.batch([
          db.insert(featureSwitch).values({ feature, state, updatedAt: now }).onConflictDoUpdate({ target: featureSwitch.feature, set: { state, updatedAt: now } }),
          db.insert(auditEntry).values(auditRow({ actor, verb: "set-feature", detail: feature, oldValue: old, newValue: state }, now)),
        ]);
        return { ok: true };
      }
      const state = pick([...OVERRIDES, "default"] as const, change.state);
      if (!state) return refuse(400, "Choose use global, on or off.");
      const user = await findUser(change.userId);
      if (!user) return refuse(404, "That user is gone.");
      const here = and(eq(featureOverride.userId, user.id), eq(featureOverride.feature, feature));
      const old = (await db.select().from(featureOverride).where(here).limit(1))[0]?.state ?? "default";
      await db.batch([
        state === "default"
          ? db.delete(featureOverride).where(here)
          : db.insert(featureOverride).values({ userId: user.id, feature, state, updatedAt: now }).onConflictDoUpdate({ target: [featureOverride.userId, featureOverride.feature], set: { state, updatedAt: now } }),
        db.insert(auditEntry).values(auditRow({ actor, verb: "set-override", target: { id: user.id, email: user.email }, detail: feature, oldValue: old, newValue: state }, now)),
      ]);
      return { ok: true };
    },
  };
}
