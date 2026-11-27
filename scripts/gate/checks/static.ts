// Module 1: the checks that need no dev server (the build output, Tailwind, test, verify, db:reset, AGENTS.md, the setup guide, doctor, the zod types),
// and the checks on the scaffold itself that run before anything else.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, RECORD_DIR } from "../../../src/manifest";
import { run } from "../../../src/pipeline";
import { stepsFor } from "../../../src/setup";
import { TRUSTED_DEPENDENCIES } from "../../../src/versions";
import { openDb, sqliteFiles } from "../harness";
import type { Ctx } from "../shared";

// Right after the scaffold, in every permutation (the --upgrade one included).
export function scaffoldChecks(ctx: Ctx): void {
  const { config, app } = ctx;
  const pkgJson = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  if (JSON.stringify(pkgJson.trustedDependencies) !== JSON.stringify(TRUSTED_DEPENDENCIES))
    throw new Error(`package.json trustedDependencies is ${JSON.stringify(pkgJson.trustedDependencies)}`);
  if (config.framework !== "svelte") { // react, vue and solid stay as v0.1: no record, no notice
    const noticed = listFiles(app).filter((f) => readFileSync(join(app, f), "utf8").includes("Scaffold-owned by zero-stack"));
    if (existsSync(join(app, RECORD_DIR)) || noticed.length) throw new Error(`${config.framework} app has ${RECORD_DIR}/ or a notice (${noticed.join(", ")})`);
    console.log(`gate: ${config.framework} has no ${RECORD_DIR}/ and no notice`);
  }
}

// After `vp check` and `vp build`.
export async function staticChecks(ctx: Ctx): Promise<void> {
  const { config, app, root, step } = ctx;
  if (config.framework === "svelte" && config.auth) {
    // #132: nothing of tests/signed-in.ts (the testUtils plugin, a helper) is reachable in a deployed Worker: it is in no built file, and auth.ts does not name it.
    const built = readdirSync(join(app, "dist"), { recursive: true, encoding: "utf8" }).map((f) => join(app, "dist", f)).filter((f) => statSync(f).isFile());
    const texts = built.map((f) => [f, readFileSync(f, "utf8")] as const);
    const leaked = texts.filter(([, t]) => /test-utils|testUtils|tests\/signed-in/.test(t)).map(([f]) => f);
    // gate-whoami is a route the gate added: finding it proves the scan saw the Worker bundle, not only client assets.
    if (!texts.some(([, t]) => t.includes("gate-whoami"))) throw new Error(`the build output (${built.length} files) has no Worker bundle (no file names gate-whoami)`);
    if (leaked.length) throw new Error(`the build output holds the signed-in test helper: ${leaked.join(", ")}`);
    if (/testUtils|tests\/signed-in/.test(readFileSync(join(app, "auth.ts"), "utf8") + readFileSync(join(app, "src/app/auth.ts"), "utf8"))) throw new Error("the auth config names the test helper");
    console.log(`gate: the signed-in test helper is in none of the ${built.length} built files and in no auth config`);
  }
  if (config.tailwind) {
    // The banner only survives if tailwind processed pages/style.css (a raw `@import "tailwindcss"` would not have it).
    const css = readdirSync(join(app, "dist/client/assets")).filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(app, "dist/client/assets", f), "utf8"));
    if (!css.some((c) => /tailwindcss v\d/.test(c) && c.includes("--tw-"))) throw new Error("built CSS has no Tailwind output");
    console.log("gate: tailwind styles in built CSS");
  }
  await step(["test"]);
  await run([process.execPath, "run", "verify"], app);
  await run([process.execPath, "run", "db:reset"], app);
  // A reset must wipe rows, not just exit 0: plant one, reset again, expect every app table empty.
  const [dbFile, ...extra] = sqliteFiles(join(app, ".void"));
  if (!dbFile || extra.length) throw new Error(`expected one local sqlite database under .void, found ${(dbFile ? [dbFile, ...extra] : []).length}`);
  // The app table is derived, not named: any table that is not sqlite, void, drizzle or better-auth internals.
  const INTERNAL = /^(sqlite_|_void|__drizzle|user$|session$|account$|verification$)/;
  const plant = openDb(dbFile);
  const appTables = (plant.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name).filter((n) => !INTERNAL.test(n));
  if (!appTables.length) throw new Error(`db:reset check expected an app table in ${dbFile} (not sqlite_*, _void*, __drizzle*, user/session/account/verification); found none`);
  const t = appTables[0]!;
  const cols = (plant.query(`PRAGMA table_info("${t}")`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[])
    .filter((c) => c.notnull && c.dflt_value === null && !c.pk);
  plant.run(cols.length
    ? `INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(",")}) VALUES (${cols.map((c) => (/INT|REAL|NUM/i.test(c.type) ? "0" : "'stale'")).join(",")})`
    : `INSERT INTO "${t}" DEFAULT VALUES`);
  const planted = (plant.query(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c;
  plant.close();
  if (!planted) throw new Error(`db:reset check could not plant a row in ${t}`);
  await run([process.execPath, "run", "db:reset"], app);
  const after = openDb(dbFile, { readonly: true });
  const tables = (after.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_void_migrations'").all() as { name: string }[]).map((x) => x.name);
  if (!tables.includes(t)) throw new Error(`db:reset dropped the ${t} table`);
  const rows = tables.filter((t) => (after.query(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c > 0);
  after.close();
  if (rows.length) throw new Error(`db:reset left rows in: ${rows.join(", ")}`);
  console.log("gate: db:reset empties the app database");

  const agents = readFileSync(join(app, "AGENTS.md"), "utf8");
  for (const b of ["routing", "verify"])
    if (!agents.includes(`<!-- zero-stack:${b} -->`)) throw new Error(`AGENTS.md lost the zero-stack:${b} block after verify`);

  // Setup guide: the steps present are exactly the flags that are on; the wizard parses.
  {
    const setupDoc = readFileSync(join(app, "docs/setup.md"), "utf8");
    const want: [string, boolean][] = [
      ["void cloudflare login", true], ["void connect", true], ["void deploy", true], ["cf auth login", !!config.turnstile || !!config.storage], ["BETTER_AUTH_SECRET", !!config.auth], ["email.from", !!config.email],
      ["TURNSTILE_SECRET_KEY", !!config.turnstile], ["ADMIN_EMAILS", !!config.admin], ["R2 bucket", !!config.storage], ["infisical login", !!config.secrets],
      ["STRIPE_SECRET_KEY", !!config.payments], ["STRIPE_WEBHOOK_SECRET", !!config.payments], ["stripe:seed", !!config.payments],
    ];
    if (!agents.includes("## Setup")) throw new Error("AGENTS.md has no ## Setup section");
    for (const [s, on] of want)
      if (setupDoc.includes(s) !== on) throw new Error(`setup guide ${on ? "lacks" : "shows"} ${s}`);
    const wiz = join(app, "scripts/setup-wizard.sh");
    if (!existsSync(wiz)) throw new Error("no scripts/setup-wizard.sh");
    await run(["bash", "-n", wiz], app);
    console.log("gate: setup guide matches the flags; setup-wizard.sh parses");
  }

  // Doctor: `bun run doctor` under an isolated HOME with fake void (only for the account calls), infisical, cf and curl first on PATH. The real
  // void answers `env check` and `db status`; every row's result is asserted, not just the exit code.
  {
    const bin = join(app, "node_modules/.bin");
    const home = mkdtempSync(join(root, "doctor-home-"));
    const fakes = mkdtempSync(join(root, "doctor-bin-"));
    const log = join(root, "doctor-calls.log");
    writeFileSync(log, "");
    const put = (dir: string, n: string, body: string) => writeFileSync(join(dir, n), `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    const doctor = (extra: Record<string, string> = {}) => {
      const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: `${fakes}:${process.env.PATH}`, ...extra } as Record<string, string | undefined>;
      for (const k of Object.keys(env)) if (/^(CLOUDFLARE_|CF_|INFISICAL_|APP_HOST$|APP_NAME$)/.test(k)) delete env[k];
      const r = Bun.spawnSync([process.execPath, "run", "doctor"], { cwd: app, stdin: null, env });
      const out = r.stdout.toString() + r.stderr.toString();
      const rows = new Map(out.split("\n").flatMap((l) => { const m = l.match(/^(PASS|FAIL|NOT CHECKED) +(.*)$/); return m ? [[m[2]!, m[1]!] as const] : []; }));
      return { code: r.exitCode, out, rows };
    };
    const restore: (() => void)[] = [];
    // The app ships its own node_modules/.bin/cf, which the doctor puts ahead of PATH: move it aside and put the fake there.
    const hadCf = existsSync(join(bin, "cf"));
    let voidMoved = false;
    try {
      put(fakes, "infisical", "exit 0");
      put(fakes, "curl", "exit 1");
      if (hadCf) renameSync(join(bin, "cf"), join(bin, "cf.real"));
      put(bin, "cf", `[ "$1 $2" = "auth whoami" ] && echo '"authenticated": true'\nexit 0`);
      renameSync(join(bin, "void"), join(bin, "void.real"));
      voidMoved = true;
      put(bin, "void", [
        'case "$1 $2" in "cloudflare status") exit "${FAKE_CF_STATUS:-0}";; "secret list"|"email status") exit 1;; esac',
        '[ "$1 $2 $3" = "env check --remote" ] && exit 1',
        'exec "$(dirname "$0")/void.real" "$@"',
      ].join("\n"));
      const base = doctor();
      const steps = stepsFor(config);
      const want = ["Local env (void env check)", "Local migrations (void db status)", ...steps.map((s, i) => `${i + 1}. ${s.title}`), "Remote env names (void env check --remote)"];
      if (JSON.stringify([...base.rows.keys()]) !== JSON.stringify(want)) throw new Error(`doctor rows ${JSON.stringify([...base.rows.keys()])}, wanted ${JSON.stringify(want)}`);
      const connect = want[2 + steps.findIndex((s) => s.id === "cloudflare-connect")]!;
      // Every row, from the fakes: the three sign-ins pass (fake status, infisical, cf); every other step and the remote names fail (nothing is stored,
      // the app is not connected, APP_HOST is unset, the fake void refuses the account reads, and the new app is not linked).
      const PASSING = new Set(["cloudflare-login", "infisical-login", "cf-login"]);
      const expected = new Map(want.map((r, i) => [r, i < 2 || (i < want.length - 1 && PASSING.has(steps[i - 2]!.id)) ? "PASS" : "FAIL"]));
      for (const [row, res] of expected)
        if (base.rows.get(row) !== res) throw new Error(`doctor row "${row}" is ${base.rows.get(row)}, wanted ${res}:\n${base.out}`);
      if (base.code !== 1 || !base.out.includes("Start with the first FAIL.")) throw new Error(`doctor exited ${base.code}:\n${base.out}`);
      // Signed out of Cloudflare: step 1 fails, every later row is NOT CHECKED (never FAIL), the exit is non-zero.
      const out = doctor({ FAKE_CF_STATUS: "1" });
      for (const [i, row] of want.entries()) {
        const res = i < 2 ? "PASS" : i === 2 ? "FAIL" : "NOT CHECKED";
        if (out.rows.get(row) !== res) throw new Error(`signed-out doctor row "${row}" is ${out.rows.get(row)}, wanted ${res}:\n${out.out}`);
      }
      if (out.code === 0) throw new Error("signed-out doctor exited 0");
      if (!base.out.includes("fix: APP_HOST=<your host> bun run doctor")) throw new Error(`doctor Deploy row has no APP_HOST fix:\n${base.out}`);
      const calls = readFileSync(log, "utf8");
      // Only fakes and the offline local checks ran; no write, deploy, connect or network call.
      if (/^(curl|void (connect|deploy|secret put|cloudflare login))/m.test(calls)) throw new Error(`doctor made an account call:\n${calls}`);
      console.log(`gate: doctor, ${want.length} rows each as expected ("${connect}" FAIL), signed-out run NOT CHECKED after step 1, exit 1, no account call`);

      // A required env key missing flips the env row; adding it flips it back.
      const envTs = join(app, "env.ts"), dotEnv = join(app, ".env");
      const [tsOld, envOld] = [existsSync(envTs) ? readFileSync(envTs, "utf8") : null, existsSync(dotEnv) ? readFileSync(dotEnv, "utf8") : null];
      restore.push(() => { tsOld === null ? rmSync(envTs, { force: true }) : writeFileSync(envTs, tsOld); envOld === null ? rmSync(dotEnv, { force: true }) : writeFileSync(dotEnv, envOld); });
      writeFileSync(envTs, 'import { defineEnv, string } from "void/env";\nexport default defineEnv({ GATE_NEEDED: string() });\n');
      writeFileSync(dotEnv, envOld ?? "");
      if (doctor().rows.get(want[0]!) !== "FAIL") throw new Error("doctor env row did not fail with a required key missing");
      writeFileSync(dotEnv, `${envOld ?? ""}${envOld && !envOld.endsWith("\n") ? "\n" : ""}GATE_NEEDED=x\n`);
      if (doctor().rows.get(want[0]!) !== "PASS") throw new Error("doctor env row did not pass with the key set");
      restore.pop()!();

      // An unapplied local migration flips the migrations row.
      const schema = join(app, "db/schema.ts"), migs = join(app, "db/migrations"), keep = mkdtempSync(join(root, "doctor-migs-"));
      const schemaOld = readFileSync(schema, "utf8");
      cpSync(migs, join(keep, "migrations"), { recursive: true });
      restore.push(() => { writeFileSync(schema, schemaOld); rmSync(migs, { recursive: true }); cpSync(join(keep, "migrations"), migs, { recursive: true }); });
      writeFileSync(schema, `${schemaOld}\nexport const gatePending = sqliteTable("gate_pending", { id: integer("id").primaryKey() });\n`);
      await run([join(bin, "void"), "db", "generate"], app);
      if (doctor().rows.get(want[1]!) !== "FAIL") throw new Error("doctor migrations row did not fail with a pending migration");
      restore.pop()!();
      if (doctor().rows.get(want[1]!) !== "PASS") throw new Error("doctor migrations row did not pass after the pending migration was removed");
      console.log("gate: doctor env row follows a missing required key; migrations row follows a pending migration");
    } finally {
      for (const r of restore.reverse()) r();
      if (voidMoved) renameSync(join(bin, "void.real"), join(bin, "void"));
      if (hadCf) { if (existsSync(join(bin, "cf.real"))) renameSync(join(bin, "cf.real"), join(bin, "cf")); }
      else rmSync(join(bin, "cf"), { force: true });
    }
  }

  if (config.zodRpc) {
    // `vp check` does not type-check by default, so run tsc (types were regenerated by `verify`).
    const tscOk = () => run([join(app, "node_modules/.bin/tsc"), "--noEmit"], app).then(() => true, () => false);
    if (!(await tscOk())) throw new Error("tsc failed on the zod-rpc client sample");
    const rpc = join(app, "src/rpc.ts");
    const good = readFileSync(rpc, "utf8");
    writeFileSync(rpc, good.replace("{ name }", "{ nom: name }"));
    const accepted = await tscOk();
    writeFileSync(rpc, good);
    if (accepted) throw new Error("tsc accepted a body that violates the zod schema");
    console.log("gate: zod-rpc client type reflects the schema");
  }
}
