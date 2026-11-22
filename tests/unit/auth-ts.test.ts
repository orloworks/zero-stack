import { expect, test } from "bun:test";
import { FEATURE_LIST, validateFlags } from "../../src/flags";
import { composeAuthTs } from "../../src/installers/auth-ts";

// Every svelte flag combination (implications applied), as the composer sees it.
function* svelteConfigs() {
  const features = FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes("svelte"));
  for (let m = 0; m < 1 << features.length; m++) {
    const input: Record<string, unknown> = { name: "x", framework: "svelte" };
    features.forEach((f, i) => { if (m & (1 << i)) input[f.key] = true; });
    yield validateFlags(input as never).config;
  }
}

// The options object is `defineAuth(({ defaults }) => ({ ...defaults, <key>: ..., }))`; its keys are the two-space-indented `name:` lines.
const topKeys = (src: string) => [...src.matchAll(/^ {2}([A-Za-z]+):/gm)].map((m) => m[1]);

test("composed auth.ts has no duplicate top-level key, and one databaseHooks and one plugins key at most, for every flag combination", () => {
  let n = 0;
  for (const config of svelteConfigs()) {
    if (!config.auth) continue;
    const keys = topKeys(composeAuthTs(config));
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect({ config, dup }).toEqual({ config, dup: [] });
    n++;
  }
  expect(n).toBeGreaterThan(100);
});

test("invite-only still gates user creation inside the one databaseHooks object", () => {
  const { config } = validateFlags({ name: "x", framework: "svelte", inviteOnly: true });
  const src = composeAuthTs(config);
  expect(src.match(/databaseHooks:/g)).toHaveLength(1);
  expect(src).toContain('  databaseHooks: {\n    user: {\n      create: {\n        before: async (user) => {');
});
