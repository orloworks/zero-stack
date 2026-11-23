import { expect, it } from "vite-plus/test";
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
