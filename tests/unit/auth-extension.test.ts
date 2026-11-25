import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_LIST, validateFlags } from "../../src/flags";
import { composeAuthTs } from "../../src/installers/auth-ts";

// Seam 4 (#104): the auth extension. Zero-stack's plugin list goes through extendAuth, which appends the app's after it and holds every guard.
// The guards' behaviour is proven by the generated test (template/auth/svelte/tests/auth-extension.test.ts), which `verify` and the gate run in a real app.

function* svelteConfigs() {
  const features = FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes("svelte"));
  for (let m = 0; m < 1 << features.length; m++) {
    const input: Record<string, unknown> = { name: "x", framework: "svelte" };
    features.forEach((f, i) => { if (m & (1 << i)) input[f.key] = true; });
    yield validateFlags(input as never).config;
  }
}

const ZERO_ORDER = ["captcha({", 'id: "invite-only"', "admin({ bannedUserMessage", "adminGuard({", "...billingPlugins(env)"];

test("every svelte combination calls the extension once, hands zero-stack's plugins to extendAuth in order, and never spreads the app's object", () => {
  let n = 0;
  for (const config of svelteConfigs()) {
    if (!config.auth) continue;
    const src = composeAuthTs(config);
    expect(src).toContain('import authExtension from "./src/app/auth";\nimport { extendAuth } from "./src/auth-extension";\n');
    expect(src.match(/authExtension\(env\)/g)).toHaveLength(1);
    const call = /const app = extendAuth\(\[([^]*?)\], authExtension\(env\)\);\n {2}return \{/.exec(src);
    expect(call).not.toBeNull();
    const list = call![1]!;
    const at = ZERO_ORDER.map((t) => list.indexOf(t)).filter((i) => i >= 0);
    expect(at).toEqual([...at].sort((a, b) => a - b)); // captcha first, then invite-only, admin, the guard, billing
    expect(at).toHaveLength(ZERO_ORDER.filter((t) => list.includes(t)).length);
    expect(src.match(/^ {2}plugins: app\.plugins,$/gm)).toHaveLength(1); // the one plugins key
    expect(src).toContain("  trustedOrigins: [...((defaults.trustedOrigins as string[] | undefined) ?? []), ...app.trustedOrigins],");
    expect(src).not.toMatch(/\.\.\.(app|authExtension)\b(?!\.)/); // the app's object is never spread into the options
    n++;
  }
  expect(n).toBeGreaterThan(100);
});

test("the guards live in one scaffold-owned module: unknown key, id clash, endpoint key and path clash, init options and context", () => {
  const guards = readFileSync(join(import.meta.dir, "../../template/auth/svelte/src/auth-extension.ts"), "utf8");
  for (const t of ['only "plugins" and "trustedOrigins" are allowed', "has the same id as one of zero-stack's plugins", "defines the endpoint", "returns a context from init", 'from init; only "databaseHooks" and "trustedOrigins" are allowed', "getEndpoints("])
    expect(guards).toContain(t);
  // the taken keys and paths come from Better Auth's own table, not a list kept here
  expect(guards).not.toMatch(/"(deleteUser|\/delete-user)"/);
});

test("react, vue and solid keep today's auth.ts byte for byte", () => {
  for (const framework of ["react", "vue", "solid"]) {
    const { config } = validateFlags({ name: "x", framework, auth: true } as never);
    expect(composeAuthTs(config)).toBe('import { defineAuth } from "void/auth";\n\nexport default defineAuth(({ defaults }) => ({\n  ...defaults,\n  rateLimit: { storage: "database" },\n}));\n');
  }
});
