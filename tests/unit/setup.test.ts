import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_LIST, validateFlags } from "../../src/flags";
import { authEnv } from "../../src/installers/auth";
import { composeEnvTs } from "../../src/installers/env-ts";
import { composeDoctor, composeSetupDoc, composeSetupSection, composeWizard, STEPS, stepsFor, writeSetupFiles } from "../../src/setup";

const cfg = (o: object = {}) => validateFlags({ name: "app", framework: "svelte", ...o }).config;
const ALL = Object.fromEntries(FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes("svelte")).map((f) => [f.key, true]));
// Every flag alone (on its first valid framework), the full set, and one pair: a new flag is walked without editing this list.
const single = (f: (typeof FEATURE_LIST)[number]) => ({ framework: f.frameworks?.[0] ?? "svelte", [f.key]: true });
const COMBOS = [{}, ...FEATURE_LIST.map(single), ALL, { turnstile: true, admin: true }];

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

// A flag with no setup step must be a deliberate choice: add it here only when it needs nothing in production.
const NO_SETUP = new Set(["tailwind", "shadcn", "zodRpc"]);
test("every flag in FEATURE_LIST adds a setup step, or is listed as needing none", () => {
  const base = stepsFor(cfg()).length;
  for (const f of FEATURE_LIST)
    if (!NO_SETUP.has(f.key)) expect(stepsFor(cfg(single(f))).length, `--${f.flag} adds no setup step`).toBeGreaterThan(base);
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
  const all = composeWizard(cfg(ALL))!;
  expect(all).toContain("--file /dev/stdin");
  expect(all).not.toContain("=@/dev/stdin");
  expect(all).not.toContain("mktemp");
  expect(all).toContain('PATH="$PWD/node_modules/.bin:$PATH"');
});

// Runs the wizard against fake `void`/`infisical` binaries. The fake `void secret list` reports the names in $LISTED.
function wizardRun(c: ReturnType<typeof cfg>, input: string, listed: string, voidOnPath = true, putFails = "") {
  const dir = mkdtempSync(join(tmpdir(), "zs-wiz-"));
  writeSetupFiles(dir, c);
  const bin = join(dir, "fakebin");
  mkdirSync(bin);
  const fake = [
    "#!/bin/sh",
    'echo "$*" >> "$FAKE_LOG"',
    // The real CLI stores `NAME=@/dev/stdin` literally; only `--file /dev/stdin` reads stdin, so the fake refuses anything else.
    '[ "$1 $2" = "secrets set" ] && case "$*" in *"--file /dev/stdin"*) cat > "$FAKE_LOG.inf"; exit 0;; *) exit 9;; esac',
    '[ "$1 $2" = "secret put" ] && [ -n "$PUT_FAILS" ] && exit 1',
    '[ "$1 $2" = "secret put" ] && { cat > "$FAKE_LOG.stdin"; echo "$3" >> "$FAKE_LOG.listed"; exit 0; }',
    '[ "$1 $2" = "secret list" ] && { echo "$LISTED"; cat "$FAKE_LOG.listed" 2>/dev/null; exit 0; }',
    '[ "$1 $2" = "cloudflare status" ] && exit "${CF_STATUS:-0}"',
    "exit 0",
  ].join("\n");
  // `void` is a devDependency: the real one is in node_modules/.bin, not on PATH.
  const voidDir = voidOnPath ? bin : join(dir, "node_modules/.bin");
  mkdirSync(voidDir, { recursive: true });
  for (const [d, n] of [[voidDir, "void"], [bin, "infisical"], [bin, "cf"]] as const) { writeFileSync(join(d, n), fake); chmodSync(join(d, n), 0o755); }
  // A browser opener that only logs: a test must never reach the real `open` (it opened the owner's browser once).
  for (const n of ["open", "xdg-open"]) { writeFileSync(join(bin, n), '#!/bin/sh\necho "$*" >> "$FAKE_LOG.open"\n'); chmodSync(join(bin, n), 0o755); }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const r = Bun.spawnSync(["bash", join(dir, "scripts/setup-wizard.sh")], {
    cwd: dir, stdin: new TextEncoder().encode(input),
    env: { ...process.env, SETUP_WIZARD_NO_OPEN: "1", PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, LISTED: listed, PUT_FAILS: putFails },
  });
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), calls: read(log), stdin: read(log + ".stdin"), opened: read(log + ".open"), dir };
}

test("the wizard never opens a browser", () => {
  const c = cfg({ email: true, turnstile: true, admin: true });
  const r = wizardRun(c, "\n\n\n\n\n\n", "");
  expect(r.opened).toBe("");
  // Without the env var too: stdin is a pipe here, not a TTY.
  const dir = r.dir;
  const again = Bun.spawnSync(["bash", join(dir, "scripts/setup-wizard.sh")], {
    cwd: dir, stdin: new TextEncoder().encode("\n\n\n\n\n\n"),
    env: { ...process.env, SETUP_WIZARD_NO_OPEN: "", PATH: `${join(dir, "fakebin")}:${process.env.PATH}`, FAKE_LOG: join(dir, "calls.log"), LISTED: "" },
  });
  expect(readFileSync(join(dir, "calls.log.open"), { flag: "a+" }).toString()).toBe("");
}, 30_000); // two wizard runs; 5s is too short at load 100+

test("the wizard stores a typed value through void secret put and never prints it", () => {
  const r = wizardRun(cfg({ admin: true }), "boss@example.org\n", "BETTER_AUTH_SECRET");
  expect(r.code).toBe(0);
  expect(r.stdin).toBe("boss@example.org");
  expect(r.out).not.toContain("boss@example.org");
  expect(r.calls).toContain("secret put ADMIN_EMAILS");
});

test("the wizard finds void in node_modules/.bin when it is not on PATH", () => {
  const r = wizardRun(cfg({ admin: true }), "boss@example.org\n", "", false);
  expect(r.code).toBe(0);
  expect(r.calls).toContain("secret put ADMIN_EMAILS");
});

test("a failed void secret put is reported, not fatal, and lists the step once", () => {
  const r = wizardRun(cfg({ admin: true }), "boss@example.org\n", "", true, "1");
  expect(r.code).toBe(1);
  expect(r.out).toContain("void secret put ADMIN_EMAILS failed");
  expect(r.out.match(/Set the admin emails/g)!.length).toBe(2); // the stage title and one "Still to do" line
  expect(r.out).not.toContain("ADMIN_EMAILS\n  - ADMIN_EMAILS");
  expect(r.out).not.toContain("boss@example.org");
});

test("re-running skips a done step: nothing is asked or written", () => {
  const r = wizardRun(cfg({ admin: true }), "", "ADMIN_EMAILS");
  expect(r.code).toBe(0);
  expect(r.calls).not.toContain("secret put");
  expect(r.out).toContain("already done");
});

test("--secrets also writes the value to Infisical prod, through stdin, not argv or a file", () => {
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
    env: { ...process.env, SETUP_WIZARD_NO_OPEN: "1", PATH: `${join(r.dir, "fakebin")}:${process.env.PATH}`, FAKE_LOG: join(r.dir, "calls.log"), LISTED: "" },
  });
  const calls = readFileSync(join(r.dir, "calls.log"), "utf8");
  expect(again.exitCode).toBe(0);
  expect(calls).toContain("secrets set --file /dev/stdin --env=prod --silent");
  expect(calls).not.toContain("boss@example.org");
  expect(readFileSync(join(r.dir, "calls.log.inf"), "utf8")).toBe("ADMIN_EMAILS=boss@example.org\n");
});

// Kill the wizard while `infisical secrets set` hangs: no file anywhere under the run's TMPDIR or app dir may hold the value.
test("killing the wizard during the Infisical call leaves no file holding the value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-kill-"));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  writeSetupFiles(dir, cfg({ admin: true, secrets: true }));
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  const bin = join(dir, "fakebin");
  mkdirSync(bin);
  const script = (body: string) => `#!/bin/sh\n${body}\n`;
  writeFileSync(join(bin, "void"), script('[ "$1 $2" = "secret put" ] && cat >/dev/null; exit 0'));
  writeFileSync(join(bin, "infisical"), script('echo $$ > "$READY"; exec sleep 30'));
  for (const n of ["void", "infisical"]) chmodSync(join(bin, n), 0o755);
  const ready = join(dir, "ready");
  const p = Bun.spawn(["bash", join(dir, "scripts/setup-wizard.sh")], {
    cwd: dir, stdin: new Blob(["sentinel-value@x.com\n"]), stdout: "ignore", stderr: "ignore",
    env: { ...process.env, SETUP_WIZARD_NO_OPEN: "1", PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, READY: ready },
  });
  for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(50);
  expect(existsSync(ready)).toBe(true);
  p.kill("SIGHUP");
  await p.exited;
  try { process.kill(Number(readFileSync(ready, "utf8"))); } catch {}
  const hit = Bun.spawnSync(["grep", "-rl", "sentinel-value", dir, tmp]);
  expect(hit.stdout.toString()).toBe("");
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

// Runs scripts/doctor.sh under the system bash from a subdirectory, against fake CLIs that log argv and print SENTINEL on both streams.
// The fake `void secret list` prints $LISTED; `void cloudflare status` exits $CF_STATUS; the file-only steps are satisfied by the files written here.
const SENTINEL = "s3cr3t-sentinel-value";
function doctorRun(c: ReturnType<typeof cfg>, env: Record<string, string> = {}, listed = stepsFor(c).flatMap((s) => s.covers ?? []).join("\n"), connected = true) {
  const dir = mkdtempSync(join(tmpdir(), "zs-doc-"));
  writeSetupFiles(dir, c);
  mkdirSync(join(dir, ".void"));
  mkdirSync(join(dir, "src/sub"), { recursive: true });
  writeFileSync(join(dir, ".void/project.json"), `{"platform":"${connected ? "cloudflare" : "none"}"}`);
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  writeFileSync(join(dir, "void.config.ts"), "export default { email: { from: 'hi@mail.acme.com' } };\n");
  writeFileSync(join(dir, ".env"), "STRIPE_SECRET_KEY=sk_test_abc\nSTRIPE_WEBHOOK_SECRET=whsec_abc\n");
  const bin = join(dir, "fakebin");
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  mkdirSync(bin);
  const fake = [
    "#!/bin/sh",
    'echo "$(basename "$0") $*" >> "$FAKE_LOG"',
    `echo ${SENTINEL}; echo ${SENTINEL} >&2`,
    // HANG="secret list": that command never returns. HANG_MODE=child makes it spawn its own child first; otherwise it ignores ALRM and exec's sleep.
    '[ -n "$HANG" ] && [ "$1 $2" = "$HANG" ] && { if [ -n "$HANG_TRAP" ]; then echo $$ > "$FAKE_LOG.pid"; trap "exit 0" TERM; while :; do sleep 1; done; fi; if [ -n "$HANG_CHILD" ]; then sleep 30 & echo "$$ $!" > "$FAKE_LOG.pid"; wait; else trap "" ALRM; echo $$ > "$FAKE_LOG.pid"; exec sleep 30; fi; }',
    '[ "$1 $2" = "secret list" ] && { echo "$LISTED"; exit 0; }',
    '[ "$1 $2" = "cloudflare status" ] && exit "${CF_STATUS:-0}"',
    '[ "$1 $2" = "auth whoami" ] && echo \'"authenticated": true\'',
    '[ "$1 $2" = "r2 buckets" ] && { if [ -n "$BUCKETS_RAW" ]; then printf "%s\n" "$BUCKETS_RAW"; else printf "%s\n" $BUCKETS; fi; exit 0; }',
    '[ "$1 $2" = "db status" ] && { echo "${DB_OUT:-1 migration}"; exit 0; }',
    "exit 0",
  ].join("\n");
  for (const [d, n] of [[join(dir, "node_modules/.bin"), "void"], [bin, "infisical"], [bin, "cf"], [bin, "curl"]] as const) { writeFileSync(join(d, n), fake); chmodSync(join(d, n), 0o755); }
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const r = Bun.spawnSync(["/bin/bash", join(dir, "scripts/doctor.sh")], {
    cwd: join(dir, "src/sub"), stdin: null,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, LISTED: listed, BUCKETS: "app-storage", APP_HOST: "app.example.com", ...env },
  });
  const out = r.stdout.toString() + r.stderr.toString();
  return { code: r.exitCode, out, rows: out.split("\n").filter((l) => /^(PASS|FAIL|NOT CHECKED) /.test(l)), calls: readFileSync(log, "utf8"), dir };
}

test("doctor: every row passes against passing CLIs, from a subdirectory, and exits 0", () => {
  const c = cfg(ALL);
  const r = doctorRun(c);
  expect(r.out).toContain("0 failed, 0 not checked");
  expect(r.rows).toHaveLength(stepsFor(c).length + 3);
  expect(r.rows.every((l) => l.startsWith("PASS"))).toBe(true);
  expect(r.code).toBe(0);
  expect(r.calls).toContain("curl -fsS -o /dev/null https://app.example.com/");
});

test("doctor: no output of any command reaches the terminal", () => {
  const r = doctorRun(cfg(ALL));
  expect(r.out).not.toContain(SENTINEL);
  expect(r.calls.length).toBeGreaterThan(0);
});

test("doctor: a missing secret name fails that step with its guide step and the wizard", () => {
  const c = cfg({ admin: true });
  const n = stepsFor(c).findIndex((s) => s.id === "admin-emails") + 1;
  const r = doctorRun(c, {}, "");
  expect(r.code).toBe(1);
  expect(r.out).toContain(`FAIL         ${n}. Set the admin emails\n               fix: docs/setup.md step ${n}, Set the admin emails; then: bash scripts/setup-wizard.sh`);
  expect(r.out).toContain("Start with the first FAIL.");
});

test("doctor: a failed sign-in marks every later row NOT CHECKED, with no fix line of its own", () => {
  const c = cfg({ admin: true, secrets: true });
  const r = doctorRun(c, { CF_STATUS: "1" });
  expect(r.rows.slice(0, 3).map((l) => l.split(" ")[0])).toEqual(["PASS", "PASS", "FAIL"]);
  const later = r.rows.slice(3);
  expect(later).toHaveLength(stepsFor(c).length - 1 + 1);
  expect(later.every((l) => l.startsWith("NOT CHECKED"))).toBe(true);
  expect(r.out.match(/sign in first: step 1 Sign in to Cloudflare/g)).toHaveLength(later.length);
  expect(r.out.match(/fix:/g)).toHaveLength(1);
  expect(r.code).toBe(1);
});

test("doctor: migration drift fails the migrations row, even when the summary line looks fine", () => {
  const r = doctorRun(cfg(), { DB_OUT: "1 migration\nMigration drift detected between db/migrations/ and the journal" });
  expect(r.rows[0]).toStartWith("PASS");
  expect(r.rows[1]).toStartWith("FAIL         Local migrations");
  expect(r.code).toBe(1);
});

// A hung CLI must not hang the doctor, and nothing it started may survive: every pid the fake wrote is dead afterwards.
async function expectKilled(r: ReturnType<typeof doctorRun>) {
  const pids = readFileSync(join(r.dir, "calls.log.pid"), "utf8").trim().split(" ").map(Number);
  const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  for (let i = 0; i < 30 && pids.some(alive); i++) await Bun.sleep(100);
  expect(pids.filter(alive)).toEqual([]);
}

test("doctor: a CLI that ignores ALRM and is exec'd directly times out FAIL, and is killed", async () => {
  const t = Date.now();
  const r = doctorRun(cfg(), { HANG: "cloudflare status", DOCTOR_LIMIT: "1" });
  expect(Date.now() - t).toBeLessThan(15_000);
  expect(r.out).toContain("FAIL         1. Sign in to Cloudflare\n               fix: timed out after 1s");
  expect(r.code).toBe(1);
  await expectKilled(r);
}, 30_000);

test("doctor: a timed-out CLI that catches TERM and exits 0 is still FAIL, not PASS", async () => {
  const r = doctorRun(cfg(), { HANG: "cloudflare status", HANG_TRAP: "1", DOCTOR_LIMIT: "1" });
  expect(r.out).toContain("FAIL         1. Sign in to Cloudflare\n               fix: timed out after 1s");
  expect(r.code).toBe(1);
  await expectKilled(r);
}, 30_000);

test("doctor: a CLI inside $(...) (the migrations row) is killed on timeout", async () => {
  const r = doctorRun(cfg(), { HANG: "db status", DOCTOR_LIMIT: "1" });
  expect(r.out).toContain("FAIL         Local migrations (void db status)\n               fix: timed out after 1s");
  await expectKilled(r);
}, 30_000);

test("doctor: a CLI's own child process is killed on timeout too", async () => {
  const r = doctorRun(cfg({ admin: true }), { HANG: "secret list", HANG_CHILD: "1", DOCTOR_LIMIT: "1" });
  const n = stepsFor(cfg({ admin: true })).findIndex((s) => s.id === "admin-emails") + 1;
  expect(r.out).toContain(`FAIL         ${n}. Set the admin emails\n               fix: timed out after 1s`);
  await expectKilled(r);
}, 30_000);

test("the Set the sending address step fails when void.config.ts is missing", () => {
  expect(STEPS.find((s) => s.id === "email-from")!.verify).toStartWith("test -f void.config.ts &&");
});

test("doctor: APP_HOST unset fails the Deploy row with the command to run, and curl is not called", () => {
  const r = doctorRun(cfg(), { APP_HOST: "" });
  expect(r.out).toContain("FAIL         3. Deploy\n               fix: APP_HOST=<your host> bun run doctor");
  expect(r.calls).not.toContain("curl");
});

test("doctor: the app name defaults to the scaffolded name and can be overridden", () => {
  const c = cfg({ storage: true });
  expect(doctorRun(c).calls).toContain("cf r2 buckets list --name-contains app");
  expect(doctorRun(c, { APP_NAME: "renamed" }).calls).toContain("cf r2 buckets list --name-contains renamed");
});

test("doctor: the R2 row passes only on the app's exact bucket name, never a look-alike", () => {
  const res = (env: Record<string, string>) => doctorRun(cfg({ storage: true }), env).rows.find((l) => l.includes("R2 bucket"))!;
  expect(res({ BUCKETS: "app-storage" })).toMatch(/^PASS/);
  expect(res({ BUCKETS: "other-storage app-storage" })).toMatch(/^PASS/);
  for (const b of ["myapp-storage", "app2-storage", "my-app-storage", "app-storage-old", "app"]) expect(res({ BUCKETS: b })).toMatch(/^FAIL/);
  // The real CLI's output format is unconfirmed: a JSON line and a table cell must match too, and their look-alikes must not.
  for (const line of ['  "name": "app-storage",', "│ app-storage │ 2026-11-24 │"]) expect(res({ BUCKETS_RAW: line })).toMatch(/^PASS/);
  for (const line of ['  "name": "myapp-storage",', "│ app-storage-old │ 2026-11-24 │"]) expect(res({ BUCKETS_RAW: line })).toMatch(/^FAIL/);
}, 30000); // many doctor runs in a row (each spawns bash): slow on a loaded machine, so it gets more than bun's 5s default

test("doctor: the R2 row fails until the app is connected", () => {
  const r = doctorRun(cfg({ storage: true }), {}, undefined, false);
  expect(r.rows.find((l) => l.includes("R2 bucket"))).toMatch(/^FAIL/);
});

test("doctor: a step for a flag that is off has no row, and the script parses with no placeholder left", () => {
  const bare = composeDoctor(cfg());
  for (const w of ["Turnstile", "Infisical", "admin emails", "R2"]) expect(bare).not.toContain(w);
  for (const c of [cfg(), cfg(ALL)]) {
    const s = composeDoctor(c);
    expect(Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(s) }).exitCode).toBe(0);
    expect(s.replace("<your host>", "")).not.toMatch(/<[A-Za-z][^<>]*>/);
  }
});
