import { expect, test } from "bun:test";
import { validateFlags } from "../../src/flags";

test("defaults framework to react", () => {
  expect(validateFlags({ name: "my-app" })).toEqual({ name: "my-app", framework: "react" });
});

test("rejects a name Void would refuse, with a one-line fix", () => {
  expect(() => validateFlags({ name: "My_App" })).toThrow(/lowercase/);
  expect(() => validateFlags({ name: "a".repeat(64) })).toThrow(/63/);
});

test("rejects an unknown framework", () => {
  expect(() => validateFlags({ name: "x", framework: "angular" })).toThrow(/react, vue, svelte, solid/);
});
