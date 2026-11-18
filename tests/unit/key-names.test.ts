import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
// Quoted keys (`"my-key": string()`) count too, so they cannot dodge the check.
const declared = (src: string) => [...src.matchAll(/^\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)):\s/gm)].map((m) => (m[1] ?? m[2])!);
// Same rules as namesOf in template/secrets/scripts/secrets.ts: comments, blanks and lines inside an open quoted value are skipped.
const dotenvKeys = (s: string): string[] => {
  const out: string[] = [];
  let open = "";
  for (const l of s.split("\n")) {
    const closes = (t: string, q: string) => new RegExp(q === '"' ? '(?<!\\\\)"' : q).test(t);
    if (open) { if (closes(l, open)) open = ""; continue; }
    const m = /^\s*(?:export\s+)?([^\s=#][^=]*?)\s*=\s*(.*)$/.exec(l);
    if (!m) continue;
    out.push(m[1]!);
    const q = /^["'`]/.exec(m[2]!)?.[0];
    if (q && !closes(m[2]!.slice(1), q)) open = q;
  }
  return out;
};

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

test("declared() sees quoted keys in env.ts", () => {
  expect(declared('defineEnv({\n  "my-key": string(),\n  GOOD_KEY: string(),\n})')).toEqual(["my-key", "GOOD_KEY"]);
  expect(broken("my-key")).toEqual([1]);
});

const PEM = 'GOOD_KEY=1\n# note=x\nPRIVATE_PEM="-----BEGIN KEY-----\nabcDEF=ghi\nlower_body=xyz\n-----END KEY-----"\nAFTER=2\n';

test("dotenvKeys skips the body of a multi-line quoted value", () => {
  expect(dotenvKeys(PEM)).toEqual(["GOOD_KEY", "PRIVATE_PEM", "AFTER"]);
});

// Runs the real template script against a fake infisical, so the script and dotenvKeys are held to the same fixture.
test("secrets.ts push and pull never read a PEM body line as a key name", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-pem-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "infisical"), '#!/bin/sh\nfor a in "$@"; do case "$a" in --output-file=*) out="${a#--output-file=}";; esac; done\n[ -n "$out" ] && printf \'%s\' "$FAKE_EXPORT" > "$out"\nexit 0\n');
  chmodSync(join(bin, "infisical"), 0o755);
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  writeFileSync(join(dir, ".env"), PEM);
  const run = (cmd: string) => {
    const r = Bun.spawnSync([process.execPath, join(templates, "secrets/scripts/secrets.ts"), cmd], {
      cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_EXPORT: PEM },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  for (const cmd of ["push", "pull"]) {
    const r = run(cmd);
    expect([cmd, r.code, r.out.includes("abcDEF"), r.out.includes("lower_body")]).toEqual([cmd, 0, false, false]);
  }
  expect(run("push").out).toContain("Pushed 3 keys");
});

test("secrets.ts pull removes its temp file on SIGTERM and exits non-zero; a missing CLI says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-sig-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "infisical"), "#!/bin/sh\nexec sleep 1\n");
  chmodSync(join(bin, "infisical"), 0o755);
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  const script = join(templates, "secrets/scripts/secrets.ts");
  const p = Bun.spawn([process.execPath, script, "pull"], {
    cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
  });
  while (!existsSync(join(dir, ".env.pull-tmp"))) await Bun.sleep(20);
  p.kill("SIGTERM");
  expect(await p.exited).not.toBe(0);
  expect(existsSync(join(dir, ".env.pull-tmp"))).toBe(false);
  const none = Bun.spawnSync([process.execPath, script, "pull"], { cwd: dir, env: { ...process.env, PATH: dirname(process.execPath) } });
  expect(none.stderr.toString()).toContain("the Infisical CLI was not found on PATH");
}, 20_000); // the handler runs only after the 1s child exits
