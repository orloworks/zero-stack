import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { parseSetting, type SettingDecl } from "../src/lib/setting-value";

// Checks every declaration file the app has in src/app/. Each check returns the reasons it found, so the failure says what is wrong. The checks run on the app's
// files below and on bad examples after them, so a check that stops working fails here too.
const LISTS = ["features", "settings", "onboarding", "plans"];

// A runtime import (or a dynamic one) in a declaration file: only `import type` and `export type ... from` are allowed.
function runtimeImports(source: string): string[] {
  const found = source.match(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["'][^"']+["']|^\s*import\s*["'][^"']+["']|\bimport\s*\(|\brequire\s*\(/gm) ?? [];
  return found.filter((s) => !/^\s*(?:import|export)\s+type\b/.test(s)).map((s) => s.trim());
}

// Top-level keys of the SETTINGS object (two-space indent), read from the source because a duplicate key is gone once the object exists.
const settingKeys = (source: string) => [...source.matchAll(/^ {2}"?([\w-]+)"?:\s*\{/gm)].map((m) => m[1]!);
const duplicates = (names: readonly string[]) => names.filter((n, i) => names.indexOf(n) !== i);

function settingProblems(source: string, settings: Record<string, SettingDecl>): string[] {
  const out = duplicates(settingKeys(source)).map((k) => `the setting "${k}" is declared twice`);
  for (const [key, d] of Object.entries(settings)) {
    const r = parseSetting(d, d.default);
    if (!r.ok) out.push(`the default of the setting "${key}" does not fit its declaration: ${r.message}`);
  }
  return out;
}

function stepProblems(steps: readonly unknown[]): string[] {
  const out = duplicates(steps as string[]).map((s) => `the onboarding step "${s}" is declared twice`);
  for (const s of steps) if (typeof s !== "string" || !s.trim()) out.push(`an onboarding step must be a non-empty name, got ${JSON.stringify(s)}`);
  return out;
}

const root = join(import.meta.dirname, "..");
const source = (list: string) => readFileSync(join(root, "src/app", `${list}.ts`), "utf8");

it("every declaration file the app has holds data only: no runtime imports", () => {
  for (const list of LISTS.filter((l) => existsSync(join(root, "src/app", `${l}.ts`)))) expect([list, runtimeImports(source(list))]).toEqual([list, []]);
});

it("the settings are declared once each, with a default that fits the type", async () => {
  const { SETTINGS } = await import("../src/app/settings");
  expect(settingProblems(source("settings"), SETTINGS)).toEqual([]);
});

it("the onboarding steps are unique, non-empty names", async () => {
  if (!existsSync(join(root, "src/app/onboarding.ts"))) return;
  const { STEPS } = await import("../src/app/onboarding");
  expect(stepProblems(STEPS)).toEqual([]);
});

it("the checks fail with the reason", () => {
  const dup = `export const SETTINGS = {\n  "a": { type: "text", default: "x", description: "d" },\n  "a": { type: "text", default: "y", description: "d" },\n} as const;\n`;
  expect(settingProblems(dup, {})).toEqual(['the setting "a" is declared twice']);
  const bad: Record<string, SettingDecl> = { n: { type: "number", default: 500, min: 1, max: 10, description: "d" }, c: { type: "choice", values: ["a"], default: "b", description: "d" } };
  expect(settingProblems("", bad)).toEqual([
    'the default of the setting "n" does not fit its declaration: Enter a number from 1 to 10.',
    'the default of the setting "c" does not fit its declaration: Choose one of: a.',
  ]);
  expect(stepProblems(["a", "a", ""])).toEqual(['the onboarding step "a" is declared twice', 'an onboarding step must be a non-empty name, got ""']);
  expect(runtimeImports('import type { SettingDecl } from "../lib/setting-value";\nexport type { X } from "./y";\n')).toEqual([]);
  expect(runtimeImports('import { env } from "void/env";\nimport "./side";\nconst m = await import("./x");\nexport { z } from "./z";\n')).toEqual([
    'import { env } from "void/env"',
    'import "./side"',
    "import(",
    'export { z } from "./z"',
  ]);
});
