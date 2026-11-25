import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { parseSetting, type SettingDecl } from "../src/lib/setting-value";

// Checks every declaration file the app has in src/app/. Each check returns the reasons it found, so the failure says what is wrong. The checks run on the app's
// files below and on bad examples after them, so a check that stops working fails here too.
const LISTS = ["features", "settings", "onboarding", "plans"];

// A runtime import (or a dynamic one) in a declaration file: only `import type`, `export type ... from` and `import { type X }` are allowed. Comments and the text
// of strings are ignored, so prose like "these require (at least) two" is not a call. Strings are stepped over in the same pass that drops comments, so a comment
// marker inside a string ("https://x", "/admin/*") hides nothing after it.
// shortcut: a call inside `${...}` or after a regex literal holding a quote can be missed, upgrade if tsc and the build ever stop catching a runtime import here.
function runtimeImports(source: string): string[] {
  const code = source.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[^]*?\*\/|\/\/.*$/gm, (_m, s: string | undefined) => s ?? "");
  const statements = code.match(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["'][^"']+["']|^\s*import\s*["'][^"']+["']/gm) ?? [];
  const typeOnly = (s: string) => {
    if (/^\s*(?:import|export)\s+type\b/.test(s)) return true;
    const names = /^\s*import\s*\{([^}]*)\}/.exec(s)?.[1]?.split(",").map((n) => n.trim()).filter(Boolean);
    return !!names?.length && names.every((n) => n.startsWith("type "));
  };
  const strings = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  const calls = code.replace(strings, '""').match(/\bimport\s*\(|\brequire\s*\(/g) ?? [];
  return [...statements.filter((s) => !typeOnly(s)).map((s) => s.trim()), ...calls.map((c) => c.replace(/\s+/g, ""))];
}

// Top-level keys of the SETTINGS object (two-space indent), read from the source because a duplicate key is gone once the object exists. tsc (in `verify`) already
// rejects a duplicate property (TS1117) and is the real gate; this only gives the named reason, so it is deliberately simple.
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

function featureProblems(features: readonly unknown[]): string[] {
  const out = duplicates(features as string[]).map((f) => `the feature "${f}" is declared twice`);
  for (const f of features) if (typeof f !== "string" || !f.trim()) out.push(`a feature must be a non-empty name, got ${JSON.stringify(f)}`);
  return out;
}

// Plan names are what the app stores and checks, always lowercase. Lookup keys must be unique too: two plans on one Stripe price could not be told apart.
function planProblems(plans: readonly { name: string; monthly: { lookupKey: string } }[]): string[] {
  const out = duplicates(plans.map((p) => p.name)).map((n) => `the plan "${n}" is declared twice`);
  for (const p of plans) if (p.name !== p.name.toLowerCase()) out.push(`the plan name "${p.name}" must be lowercase`);
  out.push(...duplicates(plans.map((p) => p.monthly.lookupKey)).map((k) => `the lookup key "${k}" is used by more than one plan`));
  return out;
}

function planFeatureProblems(planFeatures: Record<string, readonly string[] | undefined>, features: readonly string[], plans: readonly string[]): string[] {
  const out: string[] = [];
  for (const [feature, on] of Object.entries(planFeatures)) {
    if (!features.includes(feature)) out.push(`PLAN_FEATURES names the feature "${feature}", which is not declared in FEATURES`);
    for (const plan of on ?? []) if (!plans.includes(plan)) out.push(`PLAN_FEATURES turns "${feature}" on for the plan "${plan}", which is not declared in PLANS (plan names are lowercase)`);
  }
  return out;
}

const root = join(import.meta.dirname, "..");
// By path, so the file need not exist (tsc and Vite resolve nothing): plans.ts exists with --payments only.
const loadList = (list: string): Promise<unknown> => import(/* @vite-ignore */ join(root, "src/app", `${list}.ts`));
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

it("the features are unique, non-empty names", async () => {
  const { FEATURES } = await import("../src/app/features");
  expect(featureProblems(FEATURES)).toEqual([]);
});

// The plans file exists with --payments only; PLAN_FEATURES exists with --payments and --admin.
it("the plans are unique and lowercase", async () => {
  if (!existsSync(join(root, "src/app/plans.ts"))) return;
  const { PLANS } = (await loadList("plans")) as { PLANS: readonly { name: string; monthly: { lookupKey: string } }[] };
  expect(planProblems(PLANS)).toEqual([]);
});

it("the plan features name declared features and declared plans", async () => {
  const features = await import("../src/app/features");
  if (!("PLAN_FEATURES" in features)) return;
  const { PLANS } = (await loadList("plans")) as { PLANS: readonly { name: string; monthly: { lookupKey: string } }[] };
  expect(planFeatureProblems(features.PLAN_FEATURES as Record<string, readonly string[]>, features.FEATURES, PLANS.map((p) => p.name))).toEqual([]);
});

it("the checks fail with the reason", () => {
  expect(featureProblems(["a", "a", " "])).toEqual(['the feature "a" is declared twice', 'a feature must be a non-empty name, got " "']);
  const plan = (name: string, lookupKey: string) => ({ name, monthly: { lookupKey } });
  expect(planProblems([plan("pro", "k1"), plan("pro", "k2"), plan("Business", "k1")])).toEqual([
    'the plan "pro" is declared twice',
    'the plan name "Business" must be lowercase',
    'the lookup key "k1" is used by more than one plan',
  ]);
  expect(planFeatureProblems({ a: ["pro"], ghost: ["pro", "Pro", "team"] }, ["a"], ["pro"])).toEqual([
    'PLAN_FEATURES names the feature "ghost", which is not declared in FEATURES',
    'PLAN_FEATURES turns "ghost" on for the plan "Pro", which is not declared in PLANS (plan names are lowercase)',
    'PLAN_FEATURES turns "ghost" on for the plan "team", which is not declared in PLANS (plan names are lowercase)',
  ]);
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
    'export { z } from "./z"',
    "import(",
  ]);
  expect(runtimeImports('import { type A, type B } from "./t";\n')).toEqual([]);
  expect(runtimeImports('import { type A, b } from "./t";\n')).toEqual(['import { type A, b } from "./t"']);
  expect(runtimeImports('// These require (at least) one\n/* import("x") */\nexport const D = { description: "needs require(1) or import(2)" };\nconst r = require("x");\n')).toEqual(["require("]);
  // A comment marker inside a string must not hide what follows it.
  expect(runtimeImports('export const D = { path: "/admin/*", url: "https://x", m: require("y") };\n/** doc */\nimport { env } from "void/env";\n')).toEqual(['import { env } from "void/env"', "require("]);
});
