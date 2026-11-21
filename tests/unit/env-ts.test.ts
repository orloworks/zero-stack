import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeEnvTs, renderEnvTs } from "../../src/installers/env-ts";
import { validateFlags } from "../../src/flags";

const cfg = (o: object = {}) => validateFlags({ name: "app", framework: "svelte", ...o }).config;

test("Turnstile-only output is byte-identical to the file the template used to copy", () => {
  expect(composeEnvTs(cfg({ turnstile: true }))).toBe(readFileSync(join(import.meta.dir, "fixtures/turnstile-env.ts.txt"), "utf8"));
});

test("no feature declaring a key means no env.ts", () => {
  for (const o of [{}, { auth: true }, { email: true }, { accountDeletion: true }, { storage: true }, { secrets: true }])
    expect(composeEnvTs(cfg(o))).toBeNull();
});

test("two features' keys compose into one env.ts that declares both", () => {
  const out = renderEnvTs([{ comment: "// a\n", keys: ["A_KEY: string(),"] }, { keys: ["B_KEY: string(),"] }])!;
  expect(out).toContain("// a\nexport default defineEnv({\n  A_KEY: string(),\n  B_KEY: string(),\n});\n");
  expect(out.match(/defineEnv\(/g)).toHaveLength(1);
});
