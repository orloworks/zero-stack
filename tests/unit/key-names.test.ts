import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { authEnv } from "../../src/installers/auth";
import { composeEnvTs } from "../../src/installers/env-ts";
import { validateFlags } from "../../src/flags";

// Spec #38 "Key naming convention", rules 1, 5 and 6. Returns the rules a name breaks.
const broken = (k: string): number[] => [
  ...(/^[A-Z][A-Z0-9_]*$/.test(k) ? [] : [1]),
  ...(/^VITE_/.test(k) && /SECRET|PASSWORD|TOKEN|PRIVATE/.test(k) ? [5] : []),
  ...(/^(__VOID_|VOID_)/.test(k) ? [6] : []),
];

const templates = join(import.meta.dir, "../../template");
// The env.ts of every flag set that has one: composed, never copied from a template.
const composed = (): string[] =>
  [{}, { turnstile: true }, { inviteOnly: true }, { turnstile: true, inviteOnly: true }].flatMap((o) => composeEnvTs(validateFlags({ name: "app", framework: "svelte", ...o }).config) ?? []);
// Keys declared inside defineEnv({ ... }): bare, quoted ('a-b', "a-b") or computed (["A"]) keys, with or without a space before the value,
// at a line start or after `{` or `,` (so a second key on the same line is seen too).
const declared = (src: string) =>
  [...src.matchAll(/(?:^|[{,])\s*(?:\[\s*)?(?:(["'`])(.+?)\1|([A-Za-z_$][\w$]*))\s*\]?\s*:/gm)].map((m) => (m[2] ?? m[3])!);

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
  for (const [turnstile, inviteOnly] of [[false, false], [true, false], [false, true], [true, true]]) {
    const keys = Object.keys(parseEnv(authEnv({ turnstile, inviteOnly })));
    expect(keys).toContain("BETTER_AUTH_SECRET");
    expect(keys.includes("SIGNUP_ALLOWLIST")).toBe(inviteOnly);
    for (const k of keys) expect([k, broken(k)]).toEqual([k, []]);
  }
});

test("every key declared in a composed env.ts follows the naming convention", () => {
  const files = composed();
  expect(files.length).toBeGreaterThan(0);
  for (const src of files) {
    const keys = declared(src);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect([k, broken(k)]).toEqual([k, []]);
  }
});

test("no template ships an env.ts (the composer is its only writer)", () => {
  expect(Bun.spawnSync(["find", templates, "-name", "env.ts"]).stdout.toString()).toBe("");
});

test("the template push script enforces the same three rules as the checker above", () => {
  const src = readFileSync(join(templates, "secrets/scripts/secrets.ts"), "utf8");
  for (const re of ["/^[A-Z][A-Z0-9_]*$/", "/^VITE_/", "/SECRET|PASSWORD|TOKEN|PRIVATE/", "/^(__VOID_|VOID_)/"])
    expect(src).toContain(re);
});

test("declared() sees every spelling of a key in env.ts, and the checker rejects the bad ones", () => {
  const src = "defineEnv({\n  'my-key': string(),\n  VITE_API_SECRET:string(),\n  [\"VOID_X\"]: string(),\n  \"a-b\" : string(),\n  GOOD_KEY: string().default(\"x\"),\n})";
  const keys = declared(src);
  expect(keys).toEqual(["my-key", "VITE_API_SECRET", "VOID_X", "a-b", "GOOD_KEY"]);
  expect(keys.filter((k) => broken(k).length)).toEqual(["my-key", "VITE_API_SECRET", "VOID_X", "a-b"]);
});

test("adding a bad key to the Turnstile env.ts makes the naming check fail", () => {
  const real = composeEnvTs(validateFlags({ name: "app", framework: "svelte", turnstile: true }).config)!;
  expect(declared(real).filter((k) => broken(k).length)).toEqual([]);
  for (const line of ["'my-key': string(),", "VITE_API_SECRET:string(),", '["VOID_X"]: string(),'])
    expect(declared(real.replace("});", `  ${line}\n});`)).filter((k) => broken(k).length)).toHaveLength(1);
  // A second key on the same line as an existing one.
  const same = real.replace("TURNSTILE_SECRET_KEY: string(),", "TURNSTILE_SECRET_KEY: string(), VITE_DB_PASSWORD: string(),");
  expect(same).not.toBe(real);
  expect(declared(same).filter((k) => broken(k).length)).toEqual(["VITE_DB_PASSWORD"]);
});

for (const sig of ["SIGTERM", "SIGHUP"] as const)
  test(`secrets.ts pull removes its temp file on ${sig} and exits non-zero`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "zs-sig-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "infisical"), "#!/bin/sh\nexec sleep 1\n");
    chmodSync(join(bin, "infisical"), 0o755);
    writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
    const p = Bun.spawn([process.execPath, join(templates, "secrets/scripts/secrets.ts"), "pull"], {
      cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
    });
    while (!existsSync(join(dir, ".env.pull-tmp"))) await Bun.sleep(20);
    p.kill(sig);
    expect(await p.exited).toBe(1);
    expect(existsSync(join(dir, ".env.pull-tmp"))).toBe(false);
  }, 20_000); // the handler runs only after the 1s child exits

test("a missing infisical CLI says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-nocli-"));
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  const none = Bun.spawnSync([process.execPath, join(templates, "secrets/scripts/secrets.ts"), "pull"], { cwd: dir, env: { ...process.env, PATH: dirname(process.execPath) } });
  expect(none.stderr.toString()).toContain("the Infisical CLI was not found on PATH");
});
