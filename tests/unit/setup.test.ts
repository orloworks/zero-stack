import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFlags } from "../../src/flags";
import { authEnv } from "../../src/installers/auth";
import { composeEnvTs } from "../../src/installers/env-ts";
import { composeSetupDoc, composeSetupSection, composeWizard, STEPS, stepsFor, writeSetupFiles } from "../../src/setup";

const cfg = (o: object = {}) => validateFlags({ name: "app", framework: "svelte", ...o }).config;
const ALL = { auth: true, email: true, turnstile: true, inviteOnly: true, admin: true, storage: true, secrets: true, accountDeletion: true };
const COMBOS = [{}, { auth: true }, { email: true }, { turnstile: true }, { inviteOnly: true }, { admin: true }, { storage: true }, { secrets: true }, ALL, { turnstile: true, admin: true }];

// Every env name a flag set adds (the local .env and env.ts) must have a step that puts it in production.
test("every env var a flag adds is covered by an applicable setup step", () => {
  for (const o of COMBOS) {
    const c = cfg(o);
    const names = new Set([
      ...authEnv(c).split("\n").filter(Boolean).map((l) => l.split("=")[0]!),
      ...[...(composeEnvTs(c) ?? "").matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!),
    ]);
    const covered = new Set(stepsFor(c).flatMap((s) => s.covers ?? []));
    // react/vue/solid have no authEnv .env entries beyond the auth pair; auth is off in {} so nothing is expected there.
    if (!c.auth) continue;
    for (const n of names) expect(covered, `${JSON.stringify(o)}: ${n} has no setup step`).toContain(n);
  }
});

test("no step is wrangler advice, and ids are unique", () => {
  expect(JSON.stringify(STEPS).toLowerCase()).not.toContain("wrangler");
  expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
});

test("a step that does not apply is never shown", () => {
  const bare = composeSetupSection(cfg()) + composeSetupDoc(cfg());
  for (const w of ["Turnstile", "Infisical", "ADMIN_EMAILS", "SIGNUP_ALLOWLIST", "R2", "email.from", "BETTER_AUTH_SECRET"]) expect(bare).not.toContain(w);
  expect(bare).toContain("void cloudflare login");
  expect(bare).toContain("void deploy");
  const all = composeSetupSection(cfg(ALL));
  for (const w of ["Turnstile", "Infisical", "ADMIN_EMAILS", "SIGNUP_ALLOWLIST", "R2", "email.from", "BETTER_AUTH_SECRET"]) expect(all).toContain(w);
});

test("the AGENTS.md table has one row per step and escapes pipes", () => {
  const c = cfg(ALL);
  const rows = composeSetupSection(c).split("\n").filter((l) => /^\| \d+ \|/.test(l));
  expect(rows).toHaveLength(stepsFor(c).length);
  for (const r of rows) expect(r.replace(/\\\|/g, "").split("|")).toHaveLength(7);
});

test("the wizard exists when a human step applies, and has stages only for human steps", () => {
  const w = composeWizard(cfg())!;
  expect(w).toContain("TOTAL=1");
  expect(w).not.toContain("infisical");
  expect(composeWizard(cfg(ALL))!).toContain("infisical secrets set --file");
});

// Runs the wizard against fake `void`/`infisical` binaries. The fake `void secret list` reports the names in $LISTED.
function wizardRun(c: ReturnType<typeof cfg>, input: string, listed: string) {
  const dir = mkdtempSync(join(tmpdir(), "zs-wiz-"));
  writeSetupFiles(dir, c);
  const bin = join(dir, "fakebin");
  mkdirSync(bin);
  const fake = [
    "#!/bin/sh",
    'echo "$*" >> "$FAKE_LOG"',
    '[ "$1 $2" = "secret put" ] && { cat > "$FAKE_LOG.stdin"; echo "$3" >> "$FAKE_LOG.listed"; exit 0; }',
    '[ "$1 $2" = "secret list" ] && { echo "$LISTED"; cat "$FAKE_LOG.listed" 2>/dev/null; exit 0; }',
    '[ "$1 $2" = "cloudflare status" ] && exit "${CF_STATUS:-0}"',
    "exit 0",
  ].join("\n");
  for (const n of ["void", "infisical"]) { writeFileSync(join(bin, n), fake); chmodSync(join(bin, n), 0o755); }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const r = Bun.spawnSync(["bash", join(dir, "scripts/setup-wizard.sh")], {
    cwd: dir, stdin: new TextEncoder().encode(input),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, LISTED: listed },
  });
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), calls: read(log), stdin: read(log + ".stdin"), dir };
}

test("the wizard stores a typed value through void secret put and never prints it", () => {
  const r = wizardRun(cfg({ admin: true }), "boss@example.org\n", "BETTER_AUTH_SECRET");
  expect(r.code).toBe(0);
  expect(r.stdin).toBe("boss@example.org");
  expect(r.out).not.toContain("boss@example.org");
  expect(r.calls).toContain("secret put ADMIN_EMAILS");
});

test("re-running skips a done step: nothing is asked or written", () => {
  const r = wizardRun(cfg({ admin: true }), "", "ADMIN_EMAILS");
  expect(r.code).toBe(0);
  expect(r.calls).not.toContain("secret put");
  expect(r.out).toContain("already done");
});

test("--secrets also writes the value to Infisical prod, through a file, not argv", () => {
  const c = cfg({ admin: true, secrets: true });
  const r = wizardRun(c, "boss@example.org\n", "");
  // no link file in the fake app, so Infisical is skipped; the Worker write still happens
  expect(r.calls).toContain("secret put ADMIN_EMAILS");
  expect(r.calls).not.toContain("boss@example.org");
  writeFileSync(join(r.dir, ".infisical.yaml"), "x: 1\n");
  writeFileSync(join(r.dir, "calls.log"), "");
  rmSync(join(r.dir, "calls.log.listed"), { force: true });
  const again = Bun.spawnSync(["bash", join(r.dir, "scripts/setup-wizard.sh")], {
    cwd: r.dir, stdin: new TextEncoder().encode("boss@example.org\n"),
    env: { ...process.env, PATH: `${join(r.dir, "fakebin")}:${process.env.PATH}`, FAKE_LOG: join(r.dir, "calls.log"), LISTED: "" },
  });
  const calls = readFileSync(join(r.dir, "calls.log"), "utf8");
  expect(again.exitCode).toBe(0);
  expect(calls).toMatch(/secrets set --file \S+ --env=prod --silent/);
  expect(calls).not.toContain("boss@example.org");
});

test("a value with a quote is refused and the run exits non-zero", () => {
  const r = wizardRun(cfg({ admin: true }), "a'b@x.com\n", "");
  expect(r.code).toBe(1);
  expect(r.calls).not.toContain("secret put");
});

test("bash -n accepts the wizard for every flag set that has one", () => {
  for (const o of COMBOS) {
    const w = composeWizard(cfg(o));
    if (!w) continue;
    expect(Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(w) }).exitCode).toBe(0);
  }
});
