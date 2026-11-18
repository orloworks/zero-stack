import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authEnv } from "../../src/installers/auth";

// Spec #38 "Key naming convention", rules 1, 5 and 6. Returns the rules a name breaks.
const broken = (k: string): number[] => [
  ...(/^[A-Z][A-Z0-9_]*$/.test(k) ? [] : [1]),
  ...(/^VITE_/.test(k) && /SECRET|PASSWORD|TOKEN|PRIVATE/.test(k) ? [5] : []),
  ...(/^(__VOID_|VOID_)/.test(k) ? [6] : []),
];

const templates = join(import.meta.dir, "../../template");
const envTs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? envTs(join(dir, e.name)) : e.name === "env.ts" ? [join(dir, e.name)] : []);
// Keys declared inside defineEnv({ ... }): `NAME: type()` lines.
const declared = (src: string) => [...src.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s/gm)].map((m) => m[1]!);
const dotenvKeys = (s: string) => s.split("\n").filter((l) => l.includes("=")).map((l) => l.slice(0, l.indexOf("=")));

test("the checker catches each broken rule", () => {
  expect(broken("lower_case")).toEqual([1]);
  expect(broken("1ABC")).toEqual([1]);
  expect(broken("VITE_API_SECRET")).toEqual([5]);
  expect(broken("VITE_SIGNING_TOKEN")).toEqual([5]);
  expect(broken("VOID_X")).toEqual([6]);
  expect(broken("__VOID_X")).toEqual([1, 6]);
  expect(broken("TURNSTILE_SECRET_KEY")).toEqual([]);
  expect(broken("VITE_TURNSTILE_SITE_KEY")).toEqual([]);
});

test("every key in a generated .env follows the naming convention, for every flag set", () => {
  for (const turnstile of [false, true]) {
    const keys = dotenvKeys(authEnv({ turnstile } as never));
    expect(keys).toContain("BETTER_AUTH_SECRET");
    for (const k of keys) expect([k, broken(k)]).toEqual([k, []]);
  }
});

test("every key declared in a template env.ts follows the naming convention", () => {
  const files = envTs(templates);
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const keys = declared(readFileSync(f, "utf8"));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect([f, k, broken(k)]).toEqual([f, k, []]);
  }
});

test("the template push script enforces the same three rules as the checker above", () => {
  const src = readFileSync(join(templates, "secrets/scripts/secrets.ts"), "utf8");
  for (const re of ["/^[A-Z][A-Z0-9_]*$/", "/^VITE_/", "/SECRET|PASSWORD|TOKEN|PRIVATE/", "/^(__VOID_|VOID_)/"])
    expect(src).toContain(re);
});
