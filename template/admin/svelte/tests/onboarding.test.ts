import { expect, it, vi } from "vite-plus/test";
import { buildProgress, markStep, STEPS } from "../src/onboarding";

const created = new Date("2026-11-01T00:00:00Z");

it("signed up and email verified come from the user row; declared steps from what the user reached", () => {
  const none = buildProgress({ emailVerified: false, createdAt: created }, new Map());
  expect(none).toMatchObject({ done: 1, total: 2 + STEPS.length, text: `1 of ${2 + STEPS.length}` });
  expect(none.steps.slice(0, 2)).toEqual([
    { label: "Signed up", done: true, at: created },
    { label: "Email verified", done: false, at: null },
  ]);
  const reached = new Map(STEPS.map((s) => [s as string, new Date("2026-11-02T00:00:00Z")]));
  const all = buildProgress({ emailVerified: true, createdAt: created }, reached);
  expect(all).toMatchObject({ done: 2 + STEPS.length, total: 2 + STEPS.length });
  expect(all.steps.at(-1)).toMatchObject({ label: STEPS.at(-1), done: true });
});

it("a stored step that is no longer declared is ignored, and the built-ins can't be stored", () => {
  const p = buildProgress({ emailVerified: true, createdAt: created }, new Map([["removed-step", new Date()], ["Signed up", new Date()]]));
  expect(p.steps.map((s) => s.label)).toEqual(["Signed up", "Email verified", ...STEPS]);
  expect(p.done).toBe(2);
});

it("marking an undeclared step is refused before the database is touched", async () => {
  await expect(markStep("u1", "not-declared" as never)).rejects.toThrow("Undeclared onboarding step: not-declared");
  await expect(markStep("u1", "Signed up" as never)).rejects.toThrow("Undeclared onboarding step");
});

// The real insert and its onConflictDoNothing path, on an in-memory SQLite behind the same drizzle calls (void/db is the only stand-in).
vi.mock("void/db", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const { eq, inArray } = await import("drizzle-orm");
  const sqlite = new Database(":memory:");
  sqlite.exec("create table onboarding_step (user_id text not null, step text not null, reached_at integer not null, primary key (user_id, step))");
  return { db: drizzle(sqlite), eq, inArray };
});
vi.mock("@schema", async () => await import("../db/schema/admin"));

it.skipIf(STEPS.length === 0)("markStep stores a declared step once: the second call changes nothing", async () => {
  const { db } = await import("void/db");
  const { onboardingStep } = await import("../db/schema/admin");
  const { progressFor } = await import("../src/onboarding");
  const user = { id: "u1", emailVerified: true, createdAt: created };
  expect((await progressFor([user])).get("u1")?.steps.at(-1)).toMatchObject({ done: false, at: null });
  await markStep("u1", STEPS[0]);
  const first = (await db.select().from(onboardingStep))[0];
  expect(first).toMatchObject({ userId: "u1", step: STEPS[0] });
  await new Promise((r) => setTimeout(r, 5));
  await markStep("u1", STEPS[0]); // onConflictDoNothing: no error, no second row, the first time stands
  const rows = await db.select().from(onboardingStep);
  expect(rows).toHaveLength(1);
  expect(rows[0].reachedAt).toEqual(first.reachedAt);
  const p = (await progressFor([user])).get("u1");
  expect(p?.steps.at(-1)).toMatchObject({ done: true, at: first.reachedAt });
}, 30_000); // the first call loads drizzle and better-sqlite3 cold, which a loaded machine makes slow
