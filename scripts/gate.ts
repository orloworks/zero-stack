// Scaffold into a temp dir, then vp check/build/test, verify, db:reset, GET / against vp dev.
// Optional args choose the permutation: bun scripts/gate.ts [--framework vue] [--<feature flag from src/flags.ts>...] [--name x]
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv as featureArgv, type Config, FEATURE_LIST, validateFlags } from "../src/flags";
import { type BaseCopy, listFiles, readTree, RECORD_DIR, UPGRADE_TMP } from "../src/manifest";
import { scaffoldOwned } from "../src/ownership";
import { killChildren, onTerminate, spawnTracked } from "../src/children";
import { preflight, run, scaffold } from "../src/pipeline";
import { stepsFor } from "../src/setup";
import { CREATE_VOID, TRUSTED_DEPENDENCIES } from "../src/versions";

const root = mkdtempSync(join(tmpdir(), "zs-gate-"));
const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
// Matches `--secrets infisical` and `--secrets=infisical` alike (the CLI accepts both).
const hasSeq = (seq: string[]) => argv.includes(seq.join("=")) || argv.some((_, i) => seq.every((t, j) => argv[i + j] === t));
const name = arg("--name") ?? "gate-app";
const app = join(root, name);
const vp = join(app, "node_modules/.bin/vp");
let dev: ReturnType<typeof Bun.spawn> | undefined;

// SIGINT/SIGTERM: every child (steps, dev server) is killed and awaited, then the temp dir goes; exit 130/143.
onTerminate(() => rmSync(root, { recursive: true, force: true }), 10_000);

// Request cookie header from a response's Set-Cookie headers.
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const step = (args: string[]) => run([vp, ...args], app);
// The dev server recreates its local D1 file on a restart; opening it in that window fails with "unable to open database file".
// Retry only that error, for up to 3s (seen in ci:full under load); anything else throws at once.
const openDb = (file: string, opts?: { readonly?: boolean }): Database => {
  for (let i = 0; ; i++) {
    try {
      return new Database(file, opts);
    } catch (e) {
      if (i >= 15 || !String((e as Error).message).includes("unable to open database file")) throw e;
      Bun.sleepSync(200);
    }
  }
};
const sqliteFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sqliteFiles(join(dir, e.name)) : e.name.endsWith(".sqlite") ? [join(dir, e.name)] : []);

// The upgrade honesty test (#101, entry `svelte-upgrade`): an app that edits only its declaration file upgrades with no conflict and a green verify.
// It lives here, not in a script of its own, because the ci:full cache hashes only gate.ts and src/.
async function upgradeGate(config: Config): Promise<void> {
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: app, stdout: "pipe", stderr: "pipe" });
  const commit = (msg: string) => {
    sh(["git", "add", "-A"]);
    const r = sh(["git", "-c", "user.name=gate", "-c", "user.email=gate@example.com", "commit", "-q", "-m", msg]);
    if (r.exitCode !== 0) throw new Error(`git commit failed: ${r.stderr.toString()}`);
  };
  const record = join(app, ".zero-stack/base.json");
  const steps = join(app, "src/app/onboarding.ts");
  commit("scaffold");

  // 1. Edit as an owner would: only the declaration file.
  const edited = readFileSync(steps, "utf8").replace('["example-step"]', '["signed-in-once", "invited-a-friend"]');
  if (!edited.includes("invited-a-friend")) throw new Error("src/app/onboarding.ts has no example step to edit");
  writeFileSync(steps, edited);

  // 2. Make the app look older, four ways.
  const base: BaseCopy = JSON.parse(readFileSync(record, "utf8"));
  const [aged, dropped, stale, signIn] = ["src/mail.ts", "src/lib/setting-value.ts", "src/stale.ts", "pages/sign-in.svelte"] as const;
  for (const p of [aged, dropped, signIn]) if (!base[p]) throw new Error(`${p} is not in the base copy`);
  if (!scaffoldOwned(aged) || !scaffoldOwned(dropped) || scaffoldOwned(signIn)) throw new Error("the ownership rule changed under the gate scenario");
  const agedText = readFileSync(join(app, aged), "utf8") + "// an older version of this file\n";
  writeFileSync(join(app, aged), agedText); // a scaffold-owned file and its base entry, rewritten together
  base[aged] = { ...base[aged]!, content: agedText };
  rmSync(join(app, dropped)); // dropped with its base entry: new in the new version
  delete base[dropped];
  writeFileSync(join(app, stale), "export const stale = 1;\n"); // a file the new version no longer has
  base[stale] = { mode: 0o644, encoding: "utf8", content: "export const stale = 1;\n" };
  base[signIn] = { ...base[signIn]!, content: base[signIn]!.content + "<!-- older -->\n" }; // an app-owned base entry
  writeFileSync(record, JSON.stringify(base, null, 2) + "\n");
  commit("edit and age");

  // 3. Upgrade: exit 0, one line per changed file, nothing committed.
  const r = sh([process.execPath, join(import.meta.dir, "../src/index.ts"), "upgrade"]);
  const out = r.stdout.toString();
  console.log(out.trimEnd());
  if (r.exitCode !== 0) throw new Error(`upgrade exited ${r.exitCode}: ${r.stderr.toString()}`);
  for (const line of [`replaced ${aged}`, `added ${dropped}`, `removed ${stale}`]) if (!out.includes(line)) throw new Error(`upgrade output has no "${line}":\n${out}`);
  if (out.includes("CONFLICT")) throw new Error(`upgrade reported a conflict:\n${out}`);
  if (sh(["git", "log", "--oneline"]).stdout.toString().trim().split("\n").length !== 2) throw new Error("upgrade committed");
  if (existsSync(join(app, UPGRADE_TMP))) throw new Error("upgrade left its temporary folder");

  // 4. The scaffold-owned files equal a fresh scaffold's, the owner's edit is intact, and the record is what a fresh scaffold writes.
  const freshApp = join(root, "fresh", name);
  mkdirSync(join(root, "fresh"));
  await scaffold(config, freshApp);
  const ownedOf = (dir: string) => JSON.stringify(Object.entries(readTree(dir)).filter(([p]) => scaffoldOwned(p)));
  if (ownedOf(app) !== ownedOf(freshApp)) throw new Error("the upgraded app's scaffold-owned files differ from a fresh scaffold's");
  if (readFileSync(steps, "utf8") !== edited) throw new Error("the upgrade changed the owner's edit in src/app/onboarding.ts");
  for (const f of ["manifest.json", "base.json"])
    if (readFileSync(join(app, RECORD_DIR, f), "utf8") !== readFileSync(join(freshApp, RECORD_DIR, f), "utf8")) throw new Error(`${RECORD_DIR}/${f} differs from a fresh scaffold's`);
  for (const [p, e] of Object.entries(readTree(app))) if (e.encoding === "utf8" && /^(<{7} |>{7} )/m.test(e.content)) throw new Error(`conflict markers in ${p}`);

  // 5. And it still verifies.
  await run([process.execPath, "run", "verify"], app);
  console.log("gate: upgrade replaced, added and removed what an older app needed, kept the owner's edit, matches a fresh scaffold, and verify passes");
}

try {
  preflight();
  const input = {
    name,
    framework: arg("--framework"),
    ...Object.fromEntries(FEATURE_LIST.map((f) => [f.key, hasSeq(featureArgv(f)) || undefined])),
  };
  const { config } = validateFlags(input);
  // One retry when create-void's own install fails (better-sqlite3 or esbuild install scripts die under load); scaffold deletes the half-made app first.
  await scaffold(config, app).catch((e: Error) => {
    // Only the create-void command itself, never an anchor error or a later step whose path happens to contain "create-void".
    if (!(e.message.startsWith(`${process.execPath} x create-void@${CREATE_VOID} `) && e.message.endsWith(" failed"))) throw e;
    console.error(`gate: retrying once after: ${e.message}`);
    return scaffold(config, app);
  });
  const pkgJson = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  if (JSON.stringify(pkgJson.trustedDependencies) !== JSON.stringify(TRUSTED_DEPENDENCIES))
    throw new Error(`package.json trustedDependencies is ${JSON.stringify(pkgJson.trustedDependencies)}`);
  if (config.framework !== "svelte") { // react, vue and solid stay as v0.1: no record, no notice
    const noticed = listFiles(app).filter((f) => readFileSync(join(app, f), "utf8").includes("Scaffold-owned by zero-stack"));
    if (existsSync(join(app, RECORD_DIR)) || noticed.length) throw new Error(`${config.framework} app has ${RECORD_DIR}/ or a notice (${noticed.join(", ")})`);
    console.log(`gate: ${config.framework} has no ${RECORD_DIR}/ and no notice`);
  }
  if (hasSeq(["--upgrade"])) { // gate-only flag (matrix entry svelte-upgrade): the honesty test replaces the HTTP checks
    await upgradeGate(config);
    rmSync(root, { recursive: true, force: true }); // process.exit skips the finally below; nothing else is running
    process.exit(0);
  }
  await step(["check"]);
  await step(["build"]);
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

  // Each run needs its own vite port and Cloudflare inspector port (default 9229 collides across runs).
  const freePort = () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const p = probe.port;
    probe.stop(true);
    return p;
  };
  // One retry with fresh ports when vp dev dies at start (another run took a port between freePort() and listen).
  const startDev = () => startDevOnce().catch((e: Error) => {
    if (e.message !== "vp dev exited early") throw e;
    console.error("gate: vp dev exited early, retrying once with fresh ports");
    return startDevOnce();
  });
  const startDevOnce = async () => {
    const port = freePort();
    dev = spawnTracked([vp, "dev", "--port", String(port), "--strictPort"], {
      cwd: app, stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, VOID_INSPECTOR_PORT: String(freePort()) },
    });
    let status = 0;
    // 3 min: a cold `vp dev` under parallel ci:full on a loaded machine (load avg 200+) missed 60s; a dead server still fails fast via exitCode.
    for (let i = 0; i < 360 && status !== 200; i++) {
      await Bun.sleep(500);
      if (dev.exitCode !== null) throw new Error("vp dev exited early");
      status = await fetch(`http://localhost:${port}/`).then((r) => r.status, () => 0);
    }
    if (status !== 200) throw new Error(`GET / returned ${status}`);
    return { port, status };
  };
  const { port, status } = await startDev();
  if (config.shadcn) {
    const html = await fetch(`http://localhost:${port}/`).then((r) => r.text());
    if (!html.includes('data-slot="button"')) throw new Error("shadcn Button not rendered on /");
    console.log("gate: shadcn Button rendered");
  }
  console.log(`gate: GET / -> ${status}`);
  if (config.zodRpc) {
    const post = (body: unknown) =>
      fetch(`http://localhost:${port}/api/echo`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.status);
    const [bad, good] = [await post({ name: "" }), await post({ name: "zero" })];
    console.log(`gate: POST /api/echo invalid -> ${bad}, valid -> ${good}`);
    if (bad < 400 || bad >= 500 || good !== 200) throw new Error("zod-rpc route did not validate");
  }
  // --invite-only helpers. The gate checks a proven email, so an invited sign-up makes no session and sends a verification mail whose link signs the user in.
  const kept = `kept-${Date.now()}@example.com`, pending = `pending-${Date.now()}@example.com`;
  let pendingLink: URL | undefined;
  const gatePw = "gate-password-123";
  const authPost = (b: string, path: string, body: object) =>
    fetch(b + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: b, ...(config.turnstile && { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" }) },
      body: JSON.stringify(body),
    });
  // Dev inbox: list rows carry subject, recipient and a detail link; the detail page shows the text body escaped. The token is read fresh (a restart may change it).
  const mailUrls = async (b: string, subject: string, to: string) => {
    const token = readFileSync(join(app, ".void/dev-trigger-token"), "utf8").trim();
    const inbox = (path: string) => fetch(`${b}/__void/inbox${path}`, { headers: { "x-void-dev-trigger": token } }).then((r) => r.text());
    const ids = (await inbox("")).split("<tr>").filter((r) => r.includes(`>${subject}</a>`) && r.toLowerCase().includes(to.toLowerCase()))
      .flatMap((r) => r.match(/href="\/__void\/inbox\/([^/?"]+)\?/)?.[1] ?? []);
    const urls: URL[] = [];
    for (const id of ids) {
      const url = (await inbox(`/${id}`)).match(/https?:\/\/[^\s<]+/)?.[0]?.replaceAll("&amp;", "&");
      if (url) urls.push(new URL(url));
    }
    return urls;
  };
  const mailUrl = async (b: string, subject: string, to: string) => (await mailUrls(b, subject, to))[0] ?? null;
  // Mail can be sent in the background of the request, so poll until `n` have arrived (or time out and return what is there).
  const waitMails = async (b: string, subject: string, to: string, n: number) => {
    let urls: URL[] = [];
    for (let i = 0; i < 40 && urls.length < n; i++) {
      urls = await mailUrls(b, subject, to);
      if (urls.length < n) await Bun.sleep(250);
    }
    return urls;
  };
  const follow = (b: string, u: URL) => fetch(b + u.pathname + u.search, { redirect: "manual" });
  // --invite-only: the inbox owner picks the password. Every mail to an unverified user is a set-password link; following it lands on /reset-password?token=.
  const SET_PW = "Set your password";
  const setPassword = async (b: string, link: URL, newPassword: string) => {
    const landed = new URL((await follow(b, link)).headers.get("location") ?? "", b);
    const token = landed.searchParams.get("token");
    if (landed.pathname !== "/reset-password" || !token) throw new Error(`set-password link landed on ${landed}`);
    return authPost(b, "/api/auth/reset-password", { newPassword, token });
  };
  const signInStatus = async (b: string, address: string, password: string) => (await authPost(b, "/api/auth/sign-in/email", { email: address, password })).status;
  const userRow = (address: string) =>
    sqliteFiles(join(app, ".void")).some((f) => {
      const d = openDb(f, { readonly: true });
      try {
        return !!d.query("SELECT 1 FROM sqlite_master WHERE name = 'user'").get() && !!d.query("SELECT 1 FROM user WHERE lower(email) = ?").get(address.toLowerCase());
      } finally { d.close(); }
    });
  // Runs `sql` with the user's id against the auth database (the one with a user row for the address).
  const onUser = (address: string, sql: string) => {
    for (const f of sqliteFiles(join(app, ".void"))) {
      const d = openDb(f);
      try {
        if (!d.query("SELECT 1 FROM sqlite_master WHERE name = 'user'").get()) continue;
        const u = d.query("SELECT id, emailVerified FROM user WHERE lower(email) = ?").get(address.toLowerCase()) as { id: string; emailVerified: number } | null;
        if (!u) continue;
        d.run(sql, [u.id]);
        return u;
      } finally { d.close(); }
    }
    throw new Error(`no user row for ${address}`);
  };
  const isVerified = (address: string) => !!onUser(address, "SELECT ?").emailVerified;
  // Stands in for the link expiring: removes the user's set-password rows, so the next accepted request may mail again.
  const dropLinks = (address: string) => onUser(address, "DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'");
  // Invited: the sign-up (as the page sends it, with no password) succeeds with no session cookie and mails one set-password link and no verify link;
  // setting the password through it verifies the email, and that password then signs in.
  const signUpVerified = async (b: string, address: string, password = gatePw) => {
    const up = await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: address, password: "" });
    if (!up.ok) throw new Error(`invited sign-up for ${address} -> ${up.status}`);
    if (cookieOf(up)) throw new Error(`sign-up for ${address} set a cookie before the email was verified`);
    const [link] = await waitMails(b, SET_PW, address, 1);
    if (!link) throw new Error(`no set-password mail for ${address} in the dev inbox`);
    if (await mailUrl(b, "Verify your email", address)) throw new Error(`${address} got a plain verify link`);
    const set = await setPassword(b, link, password);
    if (!set.ok) throw new Error(`set-password for ${address} -> ${set.status}`);
    const inn = await authPost(b, "/api/auth/sign-in/email", { email: address, password });
    if (!inn.ok || !/session_token=/.test(cookieOf(inn))) throw new Error(`sign-in after set-password for ${address} -> ${inn.status}`);
    return cookieOf(inn);
  };
  // Refused: no session, no user row, no mail. Status: a 200 (with verification on, Better Auth answers a refused sign-up with a placeholder user) or a 4xx (a malformed address is rejected before the hook).
  const inviteRefused = async (b: string, address: string) => {
    const r = await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: address, password: gatePw });
    if (r.status !== 200 && (r.status < 400 || r.status >= 500)) throw new Error(`refused sign-up for ${address} -> ${r.status}`);
    if (cookieOf(r)) throw new Error(`refused sign-up for ${address} set a cookie`);
    if (userRow(address)) throw new Error(`${address} was refused but has a user row`);
    for (const subject of [SET_PW, "Verify your email"]) if (await mailUrl(b, subject, address)) throw new Error(`${address} was refused but got a "${subject}" mail`);
    if ((await authPost(b, "/api/auth/sign-in/email", { email: address, password: gatePw })).ok) throw new Error(`${address} was refused but can sign in`);
  };
  // Keys are read back from the local R2 state (miniflare's _mf_objects) to prove what is stored.
  // Only the sqlite files with an _mf_objects table are R2's; any read error on one of them fails the gate.
  const r2Keys = () => {
    let found = false;
    const keys = sqliteFiles(join(app, ".void")).flatMap((f) => {
      const d = openDb(f, { readonly: true });
      try {
        if (!d.query("SELECT 1 FROM sqlite_master WHERE name = '_mf_objects'").get()) return [];
        found = true;
        return (d.query("SELECT key FROM _mf_objects").all() as { key: string }[]).map((r) => r.key);
      } catch (e) { throw new Error(`cannot read R2 keys from ${f}: ${(e as Error).message}`); } finally { d.close(); }
    });
    if (!found) throw new Error("no local R2 database (_mf_objects) found under .void");
    return keys;
  };
  if (config.auth) {
    const base = `http://localhost:${port}`;
    // The always-pass test secret accepts Cloudflare's documented dummy token; without the header the captcha plugin must refuse.
    const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
    const post = (path: string, body: object, cookie?: string) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, ...(cookie && { cookie }), ...(config.turnstile && { "x-captcha-response": DUMMY_TOKEN }) },
        body: JSON.stringify(body),
      });
    const bare = (path: string, body: object) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
    const email = `gate-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = "gate-password-123";
    if (config.turnstile) {
      const guarded = [["/api/auth/sign-up/email", { name: "Gate", email, password }], ["/api/auth/sign-in/email", { email, password }], ...(config.email ? [["/api/auth/request-password-reset", { email, redirectTo: "/reset-password" }]] : [])] as [string, object][];
      for (const [path, body] of guarded) {
        const r = await bare(path, body);
        if (r.status !== 400) throw new Error(`${path} without x-captcha-response -> ${r.status}, expected 400`);
      }
      console.log("gate: turnstile rejects sign-up, sign-in" + (config.email ? " and request-password-reset" : "") + " without a token");
    }
    const up = await post("/api/auth/sign-up/email", { name: "Gate", email, password });
    if (!up.ok) throw new Error(`auth sign-up -> ${up.status}`);
    if (config.inviteOnly) {
      // Sign-up made no session and kept no password: the sign-up's password is refused, and `password` works only once it is set through the mailed link.
      if (cookieOf(up)) throw new Error("invite-only sign-up set a cookie before the email was verified");
      if ((await post("/api/auth/sign-in/email", { email, password })).status !== 401) throw new Error("the sign-up's own password was kept");
      const [link] = await waitMails(base, SET_PW, email, 1);
      if (!link) throw new Error("no set-password mail in the dev inbox");
      if (!(await setPassword(base, link, password)).ok) throw new Error("set-password through the mailed link failed");
    }
    const inn = await post("/api/auth/sign-in/email", { email, password });
    const cookie = cookieOf(inn);
    if (!inn.ok || !cookie) throw new Error(`auth sign-in -> ${inn.status}, cookie ${cookie ? "set" : "missing"}`);
    const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } }).then((r) => r.json() as Promise<any>);
    if (session?.user?.email !== email) throw new Error("auth get-session did not return the signed-in user");
    console.log("gate: auth sign-up -> sign-in -> session ok");
    // --invite-only: the create hook refuses before any row or mail. The scaffold's list is @example.com; `kept` is an existing user for the restarts below.
    if (config.inviteOnly) {
      await signUpVerified(base, kept);
      const refused = [`nobody-${Date.now()}@evilexample.com`, `nobody-${Date.now()}@sub.example.com`, `NOBODY-${Date.now()}@EVILEXAMPLE.COM`, `a@b@example.com`, `nobody-${Date.now()}@exаmple.com`];
      for (const a of refused) await inviteRefused(base, a);
      await signUpVerified(base, `Upper-${Date.now()}@EXAMPLE.COM`); // a domain entry admits an upper-case match
      if (!(await authPost(base, "/api/auth/sign-in/email", { email: kept, password: gatePw })).ok) throw new Error("a verified user could not sign in");
      // Password after verification, in both orders: an attacker signs up the owner's address over the raw API with password P and tries P (refused, and the
      // inbox already holds a link, so no more mail); the owner signs up from the page (no password). The owner follows the one link and sets Q.
      // Then P gets 401 and Q 200. Nothing is deleted, so every link stays in the inbox; the unused ones still set a password until they expire (Better Auth's
      // reset-token lifetime), and they were only ever mailed to the inbox, so only its holder can use them.
      const takeover = async (attackerFirst: boolean) => {
        const a = `owner-${attackerFirst ? "late" : "early"}-${Date.now()}@example.com`, P = "attacker-password-1", Q = "owner-password-12";
        let mails = 0;
        const expectMails = async (n: number, what: string) => {
          const got = (await waitMails(base, SET_PW, a, n)).length;
          if (got !== n) throw new Error(`${what}: expected ${n} set-password mails for ${a}, got ${got}`);
          mails = n;
        };
        // One unexpired link per user: only the first request mails; the later sign-up and sign-in find the inbox already holds a link.
        const attacker = async () => {
          const r = await authPost(base, "/api/auth/sign-up/email", { name: "Attacker", email: a, password: P });
          if (!r.ok || cookieOf(r)) throw new Error(`attacker sign-up -> ${r.status}, cookie ${cookieOf(r) ? "set" : "none"}`);
          await Bun.sleep(500);
          await expectMails(1, "attacker sign-up");
          if ((await signInStatus(base, a, P)) !== 401) throw new Error("the attacker's sign-up password was kept");
          await Bun.sleep(500);
          await expectMails(1, "sign-in while a link is unexpired");
        };
        const owner = async () => {
          const r = await authPost(base, "/api/auth/sign-up/email", { name: "Owner", email: a, password: "" });
          if (!r.ok || cookieOf(r)) throw new Error(`owner sign-up -> ${r.status}, cookie ${cookieOf(r) ? "set" : "none"}`);
          await Bun.sleep(500);
          await expectMails(1, "owner sign-up");
        };
        if (attackerFirst) await attacker(), await owner();
        else await owner(), await attacker();
        if (config.turnstile) {
          // The captcha refuses before any hook: no token, no mail.
          if ((await bare("/api/auth/sign-up/email", { name: "X", email: a, password: P })).status !== 400) throw new Error("a sign-up without a captcha token was not refused");
          await Bun.sleep(500);
          await expectMails(mails, "a sign-up refused by the captcha");
        }
        if (await mailUrl(base, "Verify your email", a)) throw new Error(`${a} got a plain verify link`);
        if ((await authPost(base, "/api/auth/send-verification-email", { email: a })).ok) throw new Error("send-verification-email minted a verify link");
        const [link] = await mailUrls(base, SET_PW, a);
        const set = await setPassword(base, link!, Q);
        if (!set.ok) throw new Error(`owner set-password -> ${set.status}`);
        const [p, q] = [await signInStatus(base, a, P), await signInStatus(base, a, Q)];
        if (p !== 401 || q !== 200) throw new Error(`after the owner set Q: P -> ${p} (expected 401), Q -> ${q} (expected 200)`);
        // A later sign-up over the verified user changes nothing and mails nothing.
        await authPost(base, "/api/auth/sign-up/email", { name: "Late", email: a, password: P });
        await Bun.sleep(500);
        await expectMails(mails, "a sign-up over a verified user");
        const [p2, q2] = [await signInStatus(base, a, P), await signInStatus(base, a, Q)];
        if (p2 !== 401 || q2 !== 200) throw new Error(`a sign-up over a verified user changed it: P -> ${p2}, Q -> ${q2}`);
      };
      await takeover(true);
      await takeover(false);
      console.log("gate: invite-only password after verification: attacker first and owner first, the attacker's P gets 401 and the owner's Q 200; every mail is a set-password link, no verify link; a sign-up over a verified user changes nothing");
      // Mail amplification: one link per user until it expires or is used, and a rejected request mails nothing.
      const amp = `amp-${Date.now()}@example.com`;
      const ampMails = async (n: number, what: string) => {
        await Bun.sleep(500);
        const got = (await waitMails(base, SET_PW, amp, n)).length;
        if (got !== n) throw new Error(`${what}: expected ${n} set-password mails for ${amp}, got ${got}`);
      };
      await authPost(base, "/api/auth/sign-up/email", { name: "Amp", email: amp, password: "" });
      await ampMails(1, "sign-up");
      for (let i = 0; i < 5; i++) if ((await signInStatus(base, amp, `wrong-password-${i}`)) !== 401) throw new Error("a wrong-password sign-in was not 401");
      await ampMails(1, "5 wrong-password sign-ins while the link is unexpired");
      dropLinks(amp);
      const raw = (path: string, body: object, origin: string) =>
        fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin, ...(config.turnstile && { "x-captcha-response": DUMMY_TOKEN }) }, body: JSON.stringify(body) });
      const rejected = [
        await raw("/api/auth/sign-in/email", { email: amp, password: "wrong-password-x" }, "https://evil.test"),
        await raw("/api/auth/sign-up/email", { name: "Amp", email: amp, password: "" }, "https://evil.test"),
        await raw("/api/auth/sign-up/email", { email: amp, password: "" }, base),
      ].map((r) => r.status);
      if (rejected.join() !== "403,403,400") throw new Error(`cross-origin sign-in, cross-origin sign-up, no-name sign-up -> ${rejected}, expected 403,403,400`);
      await ampMails(1, "rejected requests (cross-origin, no name) with no unexpired link");
      if ((await signInStatus(base, amp, "wrong-password-y")) !== 401) throw new Error("a wrong-password sign-in was not 401");
      await ampMails(2, "a sign-in once the link is gone");
      console.log("gate: invite-only mails one set-password link per user until it expires: 5 wrong-password sign-ins add 0 mails; a cross-origin or no-name request adds 0; a sign-in after the link is gone mails again");
      // A pending (unverified) user whose address is later removed from the list: see the withList restarts below.
      await authPost(base, "/api/auth/sign-up/email", { name: "Pending", email: pending, password: "" });
      [pendingLink] = await waitMails(base, SET_PW, pending, 1);
      if (!pendingLink) throw new Error(`no set-password mail for ${pending}`);
      const signUpPage = await fetch(`${base}/sign-up`).then((r) => r.text());
      if (!signUpPage.includes('autocomplete="email"') || signUpPage.includes('type="password"')) throw new Error("the invite-only /sign-up page must ask for email and no password");
      console.log("gate: invite-only admits @example.com (any case) with no session and no kept password until the set-password link; lookalike, subdomain, two-@ and non-ASCII addresses get no session, no user row, no mail; a verified user signs in");
    }
    const file = (name: string, init: RequestInit = {}) => fetch(`${base}/api/files/${name}`, { redirect: "manual", ...init });
    const storageUser = config.storage ? ((await fetch(`${base}/api/auth/get-session`, { headers: { cookie } }).then((r) => r.json() as Promise<any>)).user.id as string) : "";
    if (config.storage) {
      if ((await file("a.txt", { method: "PUT", body: "nope" })).status !== 401) throw new Error("unauthenticated upload was not 401");
      for (const m of ["GET", "DELETE"]) if ((await file("a.txt", { method: m })).status !== 401) throw new Error(`unauthenticated ${m} was not 401`);
      const put = await file("a.txt", { method: "PUT", body: "hello storage", headers: { cookie, "content-type": "text/plain" } });
      if (put.status !== 201) throw new Error(`upload -> ${put.status}`);
      const got = await file("a.txt", { headers: { cookie } });
      if ((await got.text()) !== "hello storage" || got.headers.get("content-disposition") !== "attachment" || got.headers.get("x-content-type-options") !== "nosniff")
        throw new Error("download lost the body or the attachment/nosniff headers");
      for (const bad of ["..", "%2e%2e", "a%2Fb", "%2e%2e%2Fusers%2Fother%2Fa.txt"]) {
        const r = await file(bad, { method: "PUT", body: "x", headers: { cookie } });
        if (r.status < 400 || r.status >= 500) throw new Error(`PUT ${bad} -> ${r.status}, expected a 4xx`);
      }
      const exact = await file("exact.bin", { method: "PUT", body: new Uint8Array(10 * 1024 * 1024), headers: { cookie } });
      if (exact.status !== 201) throw new Error(`an upload of exactly 10 MB -> ${exact.status}, expected 201`);
      if ((await file("exact.bin", { method: "DELETE", headers: { cookie } })).status !== 204) throw new Error("deleting the 10 MB upload was not 204");
      // vp dev's proxy (vite -> miniflare via undici) answers 500 "fetch failed" in about 1 of 10 runs when the Worker replies before reading
      // the whole upload; the Worker said 413. Retry only that, and check below that nothing was stored either way.
      for (let i = 0; ; i++) {
        const r = await file("big.bin", { method: "PUT", body: new Uint8Array(10 * 1024 * 1024 + 1), headers: { cookie } });
        if (r.status === 413) break;
        const proxyFlake = r.status === 500 && (await r.text()).includes("fetch failed");
        if (!proxyFlake || i === 3) throw new Error(`a 10 MB + 1 byte upload -> ${r.status}, expected 413`);
      }
      const keys = r2Keys();
      if (keys.join() !== `users/${storageUser}/a.txt`) throw new Error(`R2 holds ${JSON.stringify(keys)}, expected only users/${storageUser}/a.txt`);
      console.log("gate: storage routes 401 without a session; upload/download under users/<id>/; escaping names rejected; exactly 10 MB stored; over 10 MB is 413 and stores nothing");
    }
    // Route pages for the enabled features; the loader is a file, not a route, so it is checked separately.
    const routes = ["sign-in", "sign-up", ...(config.framework === "svelte" ? ["settings"] : []), ...(config.email ? ["forgot-password", "reset-password"] : [])];
    const pageNames = readdirSync(join(app, "pages")).filter((f) => !f.includes(".server.")).map((f) => f.replace(/\.[^.]+$/, ""));
    for (const r of ["sign-in", "sign-up", "settings", "forgot-password", "reset-password"])
      if (pageNames.includes(r) !== routes.includes(r)) throw new Error(`pages/${r} ${routes.includes(r) ? "missing" : "unexpected"} for ${config.framework}`);
    for (const p of routes) {
      const r = await fetch(`${base}/${p}`);
      if (r.status !== 200) throw new Error(`GET /${p} -> ${r.status}`);
    }
    if (config.turnstile) {
      for (const p of ["sign-in", "sign-up", ...(config.email ? ["forgot-password"] : [])]) {
        const html = await fetch(`${base}/${p}`).then((r) => r.text());
        if (!html.includes("Completing a quick check")) throw new Error(`/${p} lacks the Turnstile check line`);
      }
    }
    if (config.framework === "svelte") {
      const signIn = await fetch(`${base}/sign-in`).then((r) => r.text());
      if (!/<label[^>]*for="password"/.test(signIn) || /placeholder=/.test(signIn)) throw new Error("/sign-in lacks labels or still uses placeholders");
      if (!statSync(join(app, "pages/settings.server.ts")).isFile()) throw new Error("settings.server.ts missing");
      const html = (c?: string) => fetch(`${base}/settings`, { headers: c ? { cookie: c } : {} }).then((r) => r.text());
      const [signedIn, signedOut] = [await html(cookie), await html()];
      if (!signedIn.includes("Change password") || !signedIn.includes(`Signed in as ${email}`))
        throw new Error("/settings signed in lacks the Account sections");
      if (signedOut.includes("Change password") || !signedOut.includes("Sign in to manage your account"))
        throw new Error("/settings signed out lacks the sign-in line");
      // A second session, created before the change, must be revoked by it.
      const second = cookieOf(await post("/api/auth/sign-in/email", { email, password }));
      const sessionOf = (c: string) => fetch(`${base}/api/auth/get-session`, { headers: { cookie: c } }).then((r) => r.json() as Promise<any>);
      if ((await sessionOf(second))?.user?.email !== email) throw new Error("second session did not start");
      let next = "gate-password-456";
      const wrong = await post("/api/auth/change-password", { currentPassword: "not-the-password", newPassword: next, revokeOtherSessions: true }, cookie);
      if (wrong.ok || (await wrong.json() as any)?.code !== "INVALID_PASSWORD") throw new Error(`change-password with a wrong current password -> ${wrong.status}, expected INVALID_PASSWORD`);
      const right = await post("/api/auth/change-password", { currentPassword: password, newPassword: next, revokeOtherSessions: true }, cookie);
      if (!right.ok) throw new Error(`change-password with the right password -> ${right.status}`);
      if ((await sessionOf(second))?.user) throw new Error("second session survived change-password");
      const fresh = await post("/api/auth/sign-in/email", { email, password: next });
      if (!fresh.ok) throw new Error("sign-in with the new password failed");
      console.log("gate: /settings signed in/out, change-password wrong rejected, right accepted, other session revoked");
      // change-password with revokeOtherSessions rotates the current session: its new cookie is on the `right` response.
      let live = cookieOf(right);
      if ((await sessionOf(live))?.user?.email !== email) throw new Error("no live session after change-password");
      if (config.email) {
        const signIn = await fetch(`${base}/sign-in`).then((r) => r.text());
        if (!signIn.includes('href="/forgot-password"')) throw new Error("/sign-in lacks the Forgot password? link");
        const forgot = await fetch(`${base}/forgot-password`).then((r) => r.text());
        if (!forgot.includes("Reset your password") || !forgot.includes("Send reset link")) throw new Error("/forgot-password lacks its form");
        const mailLink = async (subject: string) => {
          const url = await mailUrl(base, subject, email);
          if (!url) throw new Error(`no "${subject}" mail for ${email} in the dev inbox`);
          return url;
        };
        if (!config.inviteOnly) await mailLink("Verify your email"); // sent on sign-up, never required to sign in (--invite-only mails a set-password link instead)
        const request = await post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" });
        if (!request.ok) throw new Error(`request-password-reset -> ${request.status}`);
        const link = await mailLink("Reset your password");
        // The link redirects to /reset-password?token=...; a bad token redirects to ?error=INVALID_TOKEN.
        const follow = (u: URL) => fetch(base + u.pathname + u.search, { redirect: "manual" }).then((r) => new URL(r.headers.get("location") ?? "", base));
        const bad = await follow(new URL(link.pathname.replace(/[^/]+$/, "not-a-token") + link.search, base));
        if (bad.pathname !== "/reset-password" || bad.searchParams.get("error") !== "INVALID_TOKEN") throw new Error(`bad reset token landed on ${bad}`);
        const good = await follow(link);
        const resetToken = good.searchParams.get("token");
        if (good.pathname !== "/reset-password" || !resetToken) throw new Error(`reset link landed on ${good}`);
        const reset = await fetch(`${base}/reset-password`).then((r) => r.text());
        if (!reset.includes("Loading…") || !reset.includes('name="referrer"')) throw new Error("/reset-password lacks the loading state or no-referrer meta");
        const before = cookieOf(await post("/api/auth/sign-in/email", { email, password: next }));
        if ((await sessionOf(before))?.user?.email !== email) throw new Error("pre-reset session did not start");
        const after = "gate-password-789";
        const done = await post("/api/auth/reset-password", { newPassword: after, token: resetToken });
        if (!done.ok) throw new Error(`reset-password -> ${done.status}`);
        if ((await post("/api/auth/reset-password", { newPassword: "gate-password-000", token: resetToken })).ok) throw new Error("reset token worked twice");
        if ((await sessionOf(before))?.user || (await sessionOf(live))?.user) throw new Error("a session created before the reset survived it");
        if ((await post("/api/auth/sign-in/email", { email, password: next })).ok) throw new Error("old password still signs in after reset");
        const again = await post("/api/auth/sign-in/email", { email, password: after });
        if (!again.ok) throw new Error("sign-in with the reset password failed");
        next = after;
        live = cookieOf(again);
        console.log("gate: reset mail in dev inbox -> link -> new password signs in, bad/used token rejected, earlier sessions revoked");
      }
      if (!config.accountDeletion) {
        if (signedIn.includes("Delete account")) throw new Error("/settings has a Delete account section without --account-deletion");
      } else {
        // Runs after change-password and any reset: `next` is the current password and `live` a current session.
        if (!signedIn.includes("Delete account permanently")) throw new Error("/settings lacks the Delete account section");
        const del = (pw: string) => post("/api/auth/delete-user", { password: pw }, live);
        // Better Auth skips the password check for a session under freshAge, so a missing or empty password must still be refused.
        for (const body of [{}, { password: "" }]) {
          const r = await post("/api/auth/delete-user", body, live);
          if (r.status !== 400) throw new Error(`delete-user with body ${JSON.stringify(body)} -> ${r.status}, expected 400`);
        }
        if (!(await post("/api/auth/sign-in/email", { email, password: next })).ok) throw new Error("account stopped signing in after a passwordless deletion attempt");
        const wrongDel = await del("not-the-password");
        if (wrongDel.ok || (await wrongDel.json() as any)?.code !== "INVALID_PASSWORD") throw new Error(`delete-user with a wrong password -> ${wrongDel.status}, expected INVALID_PASSWORD`);
        if (!(await post("/api/auth/sign-in/email", { email, password: next })).ok) throw new Error("account stopped signing in after a rejected deletion");
        if ((await sessionOf(live))?.user?.email !== email) throw new Error("session lost after a rejected deletion");
        const rightDel = await del(next);
        if (!rightDel.ok) throw new Error(`delete-user with the right password -> ${rightDel.status}`);
        if ((await sessionOf(live))?.user) throw new Error("session survived account deletion");
        if ((await post("/api/auth/sign-in/email", { email, password: next })).ok) throw new Error("deleted account still signs in");
        console.log("gate: delete-user wrong password rejected (account still signs in), right password deletes the account");
        if (config.storage) {
          if (r2Keys().length) throw new Error(`account deleted but R2 still holds ${JSON.stringify(r2Keys())}`);
          console.log("gate: uploaded object gone after account deletion");
        }
      }
    }
    const migrations = readdirSync(join(app, "db/migrations")).filter((f) => f.endsWith(".sql"));
    const sql = migrations.map((f) => readFileSync(join(app, "db/migrations", f), "utf8")).join("\n");
    for (const t of ["user", "session", "account", "verification"])
      if (!new RegExp(`CREATE TABLE\\s+[\`"']?${t}\\b`, "i").test(sql)) throw new Error(`no migration creates the ${t} table`);
    // D3: the shared rate limit is in auth.ts and its table in the migration.
    if (!/rateLimit: \{\s*storage: "database"/.test(readFileSync(join(app, "auth.ts"), "utf8"))) throw new Error('auth.ts lacks rateLimit storage: "database"');
    if (!/CREATE TABLE\s+[`"']?rateLimit\b/.test(sql)) throw new Error("no migration creates the rate-limit table");
    if (!readFileSync(join(app, ".gitignore"), "utf8").split("\n").includes(".env")) throw new Error(".env not gitignored");
    if ((statSync(join(app, ".env")).mode & 0o777) !== 0o600) throw new Error(".env is not mode 0600");
    const env = readFileSync(join(app, ".env"), "utf8");
    if (!/^BETTER_AUTH_SECRET=\S{40,}$/m.test(env) || !env.includes("BETTER_AUTH_URL=http://localhost:5173"))
      throw new Error(".env missing secret or url");
    console.log("gate: auth migration present, .env gitignored");
  }
  if (config.inviteOnly) {
    // The list is read at startup: restart the dev server on a changed .env. Exact entries, then a list with no entries (fail closed).
    const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
    const withList = async (list: string) => {
      await killChildren();
      writeFileSync(envFile, original.replace(/^SIGNUP_ALLOWLIST=.*$/m, `SIGNUP_ALLOWLIST=${list}`));
      return startDev();
    };
    try {
      const exact = `exact-${Date.now()}@partner.test`;
      let { port: p } = await withList(`${exact.toUpperCase()},other@partner.test`);
      let b = `http://localhost:${p}`;
      await signUpVerified(b, exact); // an exact list entry admits its email (any case)
      await inviteRefused(b, `other2-${Date.now()}@partner.test`); // a different address on the same domain is not a domain entry
      await inviteRefused(b, `nobody-${Date.now()}@example.com`); // the list no longer holds @example.com
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: gatePw })).ok) throw new Error("an existing user could not sign in after the list changed");
      // The list no longer holds the pending user's address: an earlier set-password link and a forgot-password link are refused and do not verify,
      // and a sign-in (after its link is gone) mails nothing. A verified user who was removed from the list still resets their password.
      const pendingPw = "pending-password-1";
      for (const link of [pendingLink!, null]) {
        let l = link;
        if (!l) {
          await authPost(b, "/api/auth/request-password-reset", { email: pending, redirectTo: "/reset-password" });
          [l] = await waitMails(b, "Reset your password", pending, 1);
          if (!l) throw new Error(`no forgot-password mail for ${pending}`);
        }
        const r = await setPassword(b, l!, pendingPw);
        if (r.ok || isVerified(pending)) throw new Error(`a de-listed pending user's ${link ? "set-password" : "forgot-password"} link -> ${r.status}, verified ${isVerified(pending)}`);
        const s = await authPost(b, "/api/auth/sign-in/email", { email: pending, password: pendingPw });
        if (s.ok || cookieOf(s)) throw new Error(`a de-listed pending user signed in -> ${s.status}`);
      }
      dropLinks(pending);
      const before = (await mailUrls(b, SET_PW, pending)).length;
      await authPost(b, "/api/auth/sign-in/email", { email: pending, password: "wrong-password-z" });
      await authPost(b, "/api/auth/sign-up/email", { name: "Pending", email: pending, password: "" });
      await Bun.sleep(1000);
      if ((await mailUrls(b, SET_PW, pending)).length !== before) throw new Error("a de-listed pending user's sign-in or sign-up mailed a set-password link");
      await authPost(b, "/api/auth/request-password-reset", { email: kept, redirectTo: "/reset-password" });
      const [keptLink] = await waitMails(b, "Reset your password", kept, 1);
      if (!keptLink || !(await setPassword(b, keptLink, gatePw + "-2")).ok) throw new Error("a verified, de-listed user could not reset their password");
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: gatePw + "-2" })).ok) throw new Error("a verified, de-listed user could not sign in after a reset");
      console.log("gate: invite-only re-checks the list when the inbox is proven: a de-listed pending user's set-password and forgot-password links are refused and do not verify, its sign-in mails nothing; a verified, de-listed user still resets and signs in");
      // A truly empty value fails Void's required-env check (every request is a 500, so nothing is admitted); a list of only separators is the empty list the matcher sees.
      ({ port: p } = await withList(","));
      b = `http://localhost:${p}`;
      await inviteRefused(b, `nobody-${Date.now()}@example.com`);
      await inviteRefused(b, `nobody-${Date.now()}@partner.test`);
      if (!(await authPost(b, "/api/auth/sign-in/email", { email: kept, password: gatePw + "-2" })).ok) throw new Error("an existing user could not sign in with an empty list");
      console.log("gate: invite-only exact entry admits (any case) and a same-domain address is refused; a list with no entries refuses everyone; existing users still sign in");
    } finally {
      writeFileSync(envFile, original);
    }
  }
  if (config.admin) {
    // --admin: /admin and /api/auth/admin/* answer to ADMIN_EMAILS (verified, live) and nobody else. The list is read at startup, so each list change restarts the dev server.
    const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
    // `signup`: leave the scaffold's SIGNUP_ALLOWLIST (undefined), set it, or remove the key (null; only with --invite-only, where it is optional).
    const withAdmins = async (list: string, signup?: string | null) => {
      await killChildren();
      let text = original.replace(/^ADMIN_EMAILS=.*$/m, `ADMIN_EMAILS=${list}`);
      if (signup !== undefined) text = signup === null ? text.replace(/^SIGNUP_ALLOWLIST=.*\n/m, "") : text.replace(/^SIGNUP_ALLOWLIST=.*$/m, `SIGNUP_ALLOWLIST=${signup}`);
      writeFileSync(envFile, text);
      return `http://localhost:${(await startDev()).port}`;
    };
    // Rows in the app database (user, audit_entry, ...): the one sqlite file that has `table`.
    const rows = (table: string, sql: string, ...args: (string | number)[]) => {
      for (const f of sqliteFiles(join(app, ".void"))) {
        const d = openDb(f, { readonly: true });
        try {
          if (d.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)) return d.query(sql).all(...args) as any[];
        } finally { d.close(); }
      }
      throw new Error(`no database with a ${table} table`);
    };
    const ts = Date.now();
    const addr = (n: string) => `${n}-${ts}@example.com`;
    const [boss, plain, owner2, victim, other] = [addr("boss"), addr("plain"), addr("owner2"), addr("victim"), addr("other")];
    const idOf = (a: string) => onUser(a, "SELECT ?").id;
    const call = (b: string, method: string, path: string, cookie = "", body?: object) =>
      fetch(b + path, { method, redirect: "manual", headers: { origin: b, ...(body && { "content-type": "application/json" }), ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
    const html = (b: string, path: string, cookie = "") => call(b, "GET", path, cookie).then(async (r) => ({ status: r.status, text: await r.text(), location: r.headers.get("location") }));
    const sessionUser = (b: string, cookie: string) => fetch(`${b}/api/auth/get-session`, { headers: { cookie } }).then((r) => r.json() as Promise<any>).then((j) => j?.user ?? null);
    // A user with a session: a verified one signs in (in an invite-only app the set-password link verifies and sets the password); an unverified one only exists in an app that lets sign-in wait on mail.
    const mk = async (b: string, address: string, verified = true) => {
      let cookie = "";
      if (config.inviteOnly) {
        if (verified) cookie = await signUpVerified(b, address);
        else if (!(await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: address, password: "" })).ok) throw new Error(`sign-up for ${address} failed`);
      } else {
        if (!(await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: address, password: gatePw })).ok) throw new Error(`sign-up for ${address} failed`);
        if (verified) onUser(address, "UPDATE user SET emailVerified = 1 WHERE id = ?");
        cookie = cookieOf(await authPost(b, "/api/auth/sign-in/email", { email: address, password: gatePw }));
      }
      return { id: idOf(address), cookie };
    };
    const upload = (b: string, cookie: string, name: string, body: string) => fetch(`${b}/api/files/${name}`, { method: "PUT", body, headers: { cookie, "content-type": "text/plain" } }).then((r) => r.status);
    const signIn = (b: string, address: string, password = gatePw) => authPost(b, "/api/auth/sign-in/email", { email: address, password });
    // The 404 matrix: pages, the plugin's endpoints and our own admin route.
    const adminPaths = (id: string): [string, string][] => [["GET", "/admin"], ["GET", "/admin/audit"], ["GET", `/admin/users/${id}`], ["GET", "/admin/users"], ["GET", "/api/auth/admin/list-users"], ["GET", `/api/auth/admin/get-user?id=${id}`], ["POST", `/api/admin/users/${id}/send-link`], ["GET", "/admin/features"], ["GET", "/admin/settings"]];
    const expectAll = async (b: string, who: string, cookie: string, id: string, want: (m: string, p: string) => number) => {
      for (const [m, p] of adminPaths(id)) {
        const r = await call(b, m, p, cookie, m === "POST" ? { userId: id } : undefined);
        if (r.status !== want(m, p)) throw new Error(`${who}: ${m} ${p} -> ${r.status}, expected ${want(m, p)}`);
      }
    };
    const REFUSED = ["set-role", "create-user", "update-user", "set-user-password", "impersonate-user", "stop-impersonating", "has-permission"];
    const auditRows = () => rows("audit_entry", "SELECT * FROM audit_entry ORDER BY created_at");
    const noMail = async (a: string) => { if (rows("audit_entry", "SELECT 1 FROM audit_entry WHERE actor_email = ? OR target_email = ? OR detail LIKE ?", a.toLowerCase(), a.toLowerCase(), `%${a.toLowerCase()}%`).length) throw new Error(`the audit log still holds ${a}`); };

    try {
      let b = await withAdmins(`${boss},${owner2}`);
      const bossU = await mk(b, boss), plainU = await mk(b, plain), victimU = await mk(b, victim), otherU = await mk(b, other);
      const ownerU = config.inviteOnly ? null : await mk(b, owner2, false); // listed, not verified: sign-in waits on nothing here
      // 404 for signed out, a signed-in non-admin and a listed but unverified user; 200 for the admin.
      const any = [["signed out", ""], ["non-admin", plainU.cookie], ...(ownerU ? [["listed, unverified", ownerU.cookie]] : [])] as [string, string][];
      for (const [who, cookie] of any) await expectAll(b, who, cookie, victimU.id, () => 404);
      for (const [m, p] of adminPaths(victimU.id)) {
        const r = await call(b, m, p, bossU.cookie, m === "POST" ? { userId: victimU.id } : undefined);
        const want = p === "/admin/users" ? 302 : 200;
        if (r.status !== want) throw new Error(`admin: ${m} ${p} -> ${r.status}, expected ${want}`);
        if (p === "/admin/users" && r.headers.get("location") !== "/admin") throw new Error(`/admin/users redirected to ${r.headers.get("location")}`);
      }
      // The path spelling does not matter: a case or encoding variant is refused for a non-admin too.
      for (const p of ["/ADMIN", "/Admin/audit", "/admin/", "/%61dmin"]) if ((await fetch(b + p, { headers: { cookie: plainU.cookie } })).status !== 404) throw new Error(`non-admin GET ${p} was not 404 (redirects followed)`);
      // The plugin's endpoints the pages do not use are refused, even for an admin; so is anything not on the allowlist.
      for (const e of REFUSED) {
        const r = await call(b, "POST", `/api/auth/admin/${e}`, bossU.cookie, { userId: victimU.id, role: "admin", email: addr("x"), password: "x-password-123", name: "x", newPassword: "x-password-123", data: {} });
        if (r.status !== 404) throw new Error(`admin POST /api/auth/admin/${e} -> ${r.status}, expected 404`);
      }
      if (rows("user", "SELECT 1 FROM user WHERE role = 'admin' AND id = ?", victimU.id).length) throw new Error("set-role changed a role");
      console.log("gate: admin 404 for signed out, non-admin" + (ownerU ? ", listed-unverified" : "") + ", case/encoding variants and the 7 refused endpoints; 200 for an admin; /admin/users redirects");

      // Sign-in writes lastSignInAt (E9) and never role: only the guard writes that.
      if (!rows("user", "SELECT lastSignInAt AS t FROM user WHERE id = ?", plainU.id)[0].t) throw new Error("sign-in did not write lastSignInAt");
      if (rows("user", "SELECT role FROM user WHERE id = ?", plainU.id)[0].role === "admin") throw new Error("a non-admin has role admin");

      // Grant on a live session (O3): a listed user who verifies after signing in reaches the plugin API on the same session; the guard is what writes role.
      if (ownerU) {
        onUser(owner2, "UPDATE user SET emailVerified = 1 WHERE id = ?");
        if ((await call(b, "GET", "/api/auth/admin/list-users", ownerU.cookie)).status !== 200) throw new Error("a newly verified, listed user did not reach list-users on their existing session");
        if (rows("user", "SELECT role FROM user WHERE id = ?", ownerU.id)[0].role !== "admin") throw new Error("the guard did not sync role");
        onUser(owner2, "UPDATE user SET emailVerified = 0 WHERE id = ?");
        if ((await call(b, "GET", "/api/auth/admin/list-users", ownerU.cookie)).status !== 404) throw new Error("a listed user who is no longer verified still reached list-users");
      }

      // Users page: the admin reaches it, search finds by email and by name, no match says so, paging.
      onUser(other, "UPDATE user SET name = 'Zed Zebrowski' WHERE id = ?");
      const page = await html(b, "/admin", bossU.cookie);
      for (const t of ["<caption>", 'scope="col"', 'aria-label="Admin"', 'aria-current="page"', "Back to app", "Search email or name", 'type="search"']) if (!page.text.includes(t)) throw new Error(`/admin lacks ${t}`);
      if (!page.text.includes(`>${victim}</a>`)) throw new Error("/admin does not list the newest users");
      const byEmail = await html(b, `/admin?q=${encodeURIComponent(other.toUpperCase())}`, bossU.cookie), byName = await html(b, "/admin?q=zebrowski", bossU.cookie);
      if (!byEmail.text.includes(`>${other}</a>`) || byEmail.text.includes(`>${victim}</a>`)) throw new Error("search by email (any case) did not narrow to the user");
      if (!byName.text.includes(`>${other}</a>`) || byName.text.includes(`>${victim}</a>`)) throw new Error("search by name did not find the user");
      const none = await html(b, "/admin?q=nobody-here-xyz", bossU.cookie);
      if (!none.text.includes("No account for nobody-here-xyz.")) throw new Error("no-match copy missing");
      const wild = await html(b, "/admin?q=%25", bossU.cookie);
      if (!wild.text.includes("No account for %.")) throw new Error("a % in the search was treated as a wildcard");
      // Paging: 50 a page, newest first, with the Showing line.
      const db = sqliteFiles(join(app, ".void")).map((f) => openDb(f)).find((d) => d.query("SELECT 1 FROM sqlite_master WHERE name = 'user'").get())!;
      const now = Date.now();
      for (let i = 0; i < 52; i++) db.run("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)", [`page-${ts}-${i}`, `Page ${i}`, `page-${i}-${ts}@fixture.test`, now - 86_400_000 - i * 1000, now]);
      const total = (db.query("SELECT count(*) AS n FROM user").get() as { n: number }).n;
      db.close();
      const p1 = await html(b, "/admin", bossU.cookie), p2 = await html(b, "/admin?page=2", bossU.cookie);
      if (!p1.text.includes(`Showing 1–50 of ${total}`) || !p1.text.includes("Older") || p1.text.includes("Newer")) throw new Error("page 1 lacks the Showing line and an Older link");
      if (!p2.text.includes(`Showing 51–${total} of ${total}`) || !p2.text.includes("Newer")) throw new Error("page 2 lacks the Showing line and a Newer link");
      const rowsOn = (t: string) => t.split("<tr>").length - 2;
      if (rowsOn(p1.text) !== 50) throw new Error(`page 1 lists ${rowsOn(p1.text)} rows, expected 50`);
      if (p1.text.indexOf(`>${victim}</a>`) > p1.text.indexOf(`>page-0-${ts}@fixture.test</a>`)) throw new Error("users are not newest first");
      // The delete action's redirect banner, and a failed load is not an empty list.
      if (!(await html(b, "/admin?deleted=gone%40x.com", bossU.cookie)).text.includes("Deleted gone@x.com and their files.")) throw new Error("the deleted banner is missing");
      console.log("gate: admin Users page: search by email (any case) and by name, no-match copy, % is not a wildcard, 50 a page newest first with Showing and Newer/Older");

      // Ban: sessions gone, sign-in refused with the blocked copy, audit entry, reason shown to admins only; unban restores.
      const victimB = cookieOf(await signIn(b, victim)) || victimU.cookie;
      const ban = await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "spam signup" });
      if (ban.status !== 200) throw new Error(`ban-user -> ${ban.status}`);
      if (await sessionUser(b, victimB)) throw new Error("a banned user's session survived");
      const refused = await signIn(b, victim);
      const refusedBody = (await refused.json()) as any;
      if (refused.ok || refusedBody?.code !== "BANNED_USER" || refusedBody?.message !== "This account has been blocked. Contact the site owner.") throw new Error(`a banned user's sign-in -> ${refused.status} ${JSON.stringify(refusedBody)}`);
      const detail = await html(b, `/admin/users/${victimU.id}`, bossU.cookie);
      if (!detail.text.includes("Banned") || !detail.text.includes("spam signup") || !detail.text.includes("Unban")) throw new Error("user detail does not show the ban, its reason and Unban");
      const live = await html(b, `/admin/users/${otherU.id}`, bossU.cookie);
      for (const t of ["Only admins see this.", "Active, last sign-in", `aria-label="Ban ${other}"`, "Danger zone", "Delete user permanently", `Type ${other} to confirm`, "Send reset link", 'tabindex="-1"']) if (!live.text.includes(t)) throw new Error(`user detail lacks ${t}`);
      if (JSON.stringify(refusedBody).includes("spam")) throw new Error("the ban reason reached the banned user");
      if (!auditRows().some((r) => r.verb === "ban" && r.target_email === victim && r.actor_email === boss && r.detail === "spam signup" && r.old_value === "active" && r.new_value === "banned")) throw new Error("no audit entry for the ban");
      // B2: a re-ban writes its own entry (banned -> banned, new reason); banExpiresIn is refused (D12) with no change and no entry.
      const banEntries = () => auditRows().filter((r) => r.verb === "ban").length;
      const banned0 = banEntries();
      if ((await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "second reason" })).status !== 200 || banEntries() !== banned0 + 1 || !auditRows().some((r) => r.verb === "ban" && r.detail === "second reason" && r.old_value === "banned" && r.new_value === "banned")) throw new Error("a re-ban did not write one banned -> banned entry");
      if ((await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: victimU.id, banReason: "x", banExpiresIn: 60 })).status !== 400 || banEntries() !== banned0 + 1) throw new Error("ban with banExpiresIn was not refused 400 with no entry");
      console.log("gate: admin re-ban writes one banned -> banned entry; banExpiresIn is refused 400");
      if ((await call(b, "POST", "/api/auth/admin/unban-user", bossU.cookie, { userId: victimU.id })).status !== 200) throw new Error("unban-user failed");
      if (!(await signIn(b, victim)).ok) throw new Error("an unbanned user could not sign in");
      if (!auditRows().some((r) => r.verb === "unban" && r.target_email === victim)) throw new Error("no audit entry for the unban");
      console.log("gate: admin ban ends sessions, sign-in shows the blocked copy (no reason), reason on user detail and in the audit entry; unban restores sign-in");

      // Revoke one session, then the rest.
      await signIn(b, victim);
      await signIn(b, victim);
      const sessionsOf = () => rows("session", "SELECT id, token FROM session WHERE userId = ?", victimU.id) as { id: string; token: string }[];
      const before = sessionsOf();
      if (before.length < 2) throw new Error(`${before.length} sessions for the victim`);
      // CSO-1: no token reaches the admin's browser. The plugin's list endpoint is off the allowlist (404 even for an admin), and the User detail page ships ids only.
      if ((await call(b, "POST", "/api/auth/admin/list-user-sessions", bossU.cookie, { userId: victimU.id })).status !== 404) throw new Error("an admin's raw list-user-sessions was not 404");
      const victimPage = await html(b, `/admin/users/${victimU.id}`, bossU.cookie);
      if (before.some((s) => victimPage.text.includes(s.token))) throw new Error("the User detail page ships a raw session token");
      const revokeUrl = (id: string, sid: string) => `/api/admin/users/${id}/sessions/${sid}/revoke`;
      // A foreign or missing Origin is refused with no side effects; so is a session id that is not this user's.
      const post = (path: string, origin?: string) => fetch(b + path, { method: "POST", headers: { cookie: bossU.cookie, ...(origin && { origin }) } });
      const audited = auditRows().length;
      const refusals = [await post(revokeUrl(victimU.id, before[0]!.id)), await post(revokeUrl(victimU.id, before[0]!.id), "https://evil.test"), await post(`/api/admin/users/${victimU.id}/send-link`), await post(`/api/admin/users/${victimU.id}/send-link`, "https://evil.test")];
      // No Origin: our 403. A foreign Origin: Void drops the session before our route runs (404, as the review saw); our 403 is the backstop. Either way nothing happens.
      const st = refusals.map((r) => r.status);
      if (st[0] !== 403 || st[2] !== 403 || ![403, 404].includes(st[1]!) || ![403, 404].includes(st[3]!)) throw new Error(`no-Origin and cross-origin revoke/send-link -> ${st}, expected 403 for no Origin and 403 or 404 for a foreign one`);
      if (sessionsOf().length !== before.length || auditRows().length !== audited) throw new Error("a refused revoke or send-link changed a session or wrote an audit entry");
      const foreignSid = (rows("session", "SELECT id FROM session WHERE userId = ?", bossU.id) as { id: string }[])[0]?.id;
      if (!foreignSid) throw new Error("the admin has no session row to use as another user's session id");
      const sessionsBefore = sessionsOf().length;
      const auditBefore = auditRows().length;
      if ((await call(b, "POST", revokeUrl(victimU.id, foreignSid), bossU.cookie)).status !== 404) throw new Error("revoke of another user's session id under the victim's URL was not 404");
      if (sessionsOf().length !== sessionsBefore) throw new Error("a refused revoke changed the session count");
      if (auditRows().length !== auditBefore) throw new Error("a refused revoke wrote an audit entry");
      if ((await call(b, "POST", revokeUrl(victimU.id, "no-such"), bossU.cookie)).status !== 404) throw new Error("revoke of an unknown session id was not 404");
      if ((await call(b, "POST", revokeUrl(victimU.id, before[0]!.id), plainU.cookie)).status !== 404) throw new Error("a non-admin's revoke was not 404");
      const revoke = await call(b, "POST", revokeUrl(victimU.id, before[0]!.id), bossU.cookie);
      if (revoke.status !== 200 || sessionsOf().length !== before.length - 1 || auditRows().filter((r) => r.verb === "revoke-session").length !== 1) throw new Error(`revoke by id -> ${revoke.status}, ${sessionsOf().length} of ${before.length} sessions left`);
      if ((await call(b, "POST", "/api/auth/admin/revoke-user-sessions", bossU.cookie, { userId: victimU.id })).status !== 200 || sessionsOf().length) throw new Error("revoke-user-sessions left a session");
      if (!auditRows().some((r) => r.verb === "revoke-session" && r.target_email === victim) || !auditRows().some((r) => r.verb === "revoke-sessions" && r.target_email === victim)) throw new Error("no audit entries for the revokes");
      console.log("gate: admin revoke one session then all; audit entries for both");

      // Send link: the server route calls requestPasswordReset (no Turnstile token needed), the mail lands in the dev inbox, the link sets a new password.
      const sent = await call(b, "POST", `/api/admin/users/${victimU.id}/send-link`, bossU.cookie);
      if (sent.status !== 200 || ((await sent.json()) as any).kind !== "reset") throw new Error(`send-link -> ${sent.status}`);
      const [resetLink] = await waitMails(b, "Reset your password", victim, 1);
      if (!resetLink) throw new Error("no reset mail in the dev inbox");
      const landed = new URL((await follow(b, resetLink)).headers.get("location") ?? "", b);
      const token = landed.searchParams.get("token");
      if (landed.pathname !== "/reset-password" || !token) throw new Error(`reset link landed on ${landed}`);
      const NEW_PW = "admin-sent-password-1";
      if (!(await authPost(b, "/api/auth/reset-password", { newPassword: NEW_PW, token })).ok || !(await signIn(b, victim, NEW_PW)).ok) throw new Error("the sent link did not set a new password");
      if (!auditRows().some((r) => r.verb === "send-link" && r.target_email === victim)) throw new Error("no audit entry for the link");
      if (config.inviteOnly) {
        // An unverified user in an invite-only app gets a set-password link with its own subject.
        const pend = addr("pending");
        await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: pend, password: "" });
        const pid = idOf(pend);
        const r = await call(b, "POST", `/api/admin/users/${pid}/send-link`, bossU.cookie);
        if (r.status !== 200 || ((await r.json()) as any).kind !== "set-password") throw new Error(`send-link for an unverified user -> ${r.status}`);
        if ((await waitMails(b, SET_PW, pend, 2)).length < 2) throw new Error("the admin's set-password link was not mailed");
      }
      if ((await call(b, "POST", `/api/admin/users/not-a-user/send-link`, bossU.cookie)).status !== 404) throw new Error("send-link for a missing user was not 404");
      console.log("gate: admin send-link lands in the dev inbox and sets a new password" + (config.turnstile ? " (no Turnstile token)" : "") + (config.inviteOnly ? "; a set-password link for an unverified user" : ""));

      // Self-protection: the plugin refuses a self-ban and self-delete (400); the guard refuses before anything is purged.
      let kept = "";
      if (config.storage) {
        if ((await upload(b, bossU.cookie, "mine.txt", "mine")) !== 201) throw new Error("the admin's own upload failed");
        kept = `users/${bossU.id}/mine.txt`;
      }
      for (const [p, want] of [["ban-user", 400], ["remove-user", 400]] as const) {
        const r = await call(b, "POST", `/api/auth/admin/${p}`, bossU.cookie, { userId: bossU.id });
        if (r.status !== want) throw new Error(`self ${p} -> ${r.status}, expected ${want}`);
      }
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", bossU.id).length || (kept && !r2Keys().includes(kept)) || !(await sessionUser(b, bossU.cookie))) throw new Error("a refused self-delete changed something");
      await signIn(b, boss); // a second session, so "Revoke all other sessions" is offered
      const own = await html(b, `/admin/users/${bossU.id}`, bossU.cookie);
      if (!own.text.includes("This is you. Use Account settings to delete your own account.") || own.text.includes("Delete user permanently")) throw new Error("own user detail offers Ban or Delete");
      if (!own.text.includes("This device") || !own.text.includes("Revoke all other sessions")) throw new Error("own user detail lacks This device or Revoke all other sessions");
      console.log("gate: admin self-ban and self-delete refused (400), own detail page says 'This is you.' and labels This device");

      // Before-hooks run ahead of the endpoint's own checks: a cross-origin delete with the admin's cookie must be refused before the guard purges anything.
      const keep = await mk(b, addr("keep"));
      if (config.storage && (await upload(b, keep.cookie, "keep.txt", "keep")) !== 201) throw new Error("the kept user's upload failed");
      const evil = await fetch(`${b}/api/auth/admin/remove-user`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", cookie: bossU.cookie }, body: JSON.stringify({ userId: keep.id }) });
      if (evil.status !== 403) throw new Error(`a cross-origin remove-user -> ${evil.status}, expected 403`);
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", keep.id).length || (config.storage && !r2Keys().includes(`users/${keep.id}/keep.txt`))) throw new Error("a refused cross-origin remove-user purged files or deleted the user");
      if (auditRows().some((r) => r.verb === "delete-user")) throw new Error("a refused cross-origin remove-user was audited");
      // B1: the plugin coerces userId, so an array must be refused by the guard (400) before the purge or the delete runs.
      const arr = await call(b, "POST", "/api/auth/admin/remove-user", bossU.cookie, { userId: [keep.id] });
      if (arr.status !== 400) throw new Error(`remove-user with an array userId -> ${arr.status}, expected 400`);
      if (!rows("user", "SELECT 1 FROM user WHERE id = ?", keep.id).length || (config.storage && !r2Keys().includes(`users/${keep.id}/keep.txt`)) || auditRows().some((r) => r.verb === "delete-user")) throw new Error("an array-userId remove-user deleted, purged or was audited");

      // Delete: the user row, sessions and files go; no audit entry holds the deleted email once the request is done; the delete itself is recorded without a target.
      const del = await mk(b, addr("doomed"));
      const doomed = addr("doomed");
      if (config.storage) {
        if ((await upload(b, del.cookie, "theirs.txt", "bye")) !== 201) throw new Error("the doomed user's upload failed");
        if (!r2Keys().includes(`users/${del.id}/theirs.txt`)) throw new Error("the doomed user's file is not in R2");
      }
      onUser(doomed, "INSERT INTO onboarding_step (user_id, step, reached_at) VALUES (?, 'example-step', 1700000000000)");
      if (!rows("onboarding_step", "SELECT 1 FROM onboarding_step WHERE user_id = ?", del.id).length) throw new Error("no onboarding row to cascade");
      await call(b, "POST", "/api/auth/admin/ban-user", bossU.cookie, { userId: del.id, banReason: `note about ${doomed}` });
      if ((await call(b, "POST", `/api/admin/users/${del.id}/features/example-feature`, bossU.cookie, { state: "on" })).status !== 200) throw new Error("setting the doomed user's override failed");
      const removed = await call(b, "POST", "/api/auth/admin/remove-user", bossU.cookie, { userId: del.id });
      if (removed.status !== 200) throw new Error(`remove-user -> ${removed.status}`);
      if (rows("user", "SELECT 1 FROM user WHERE id = ?", del.id).length || (await sessionUser(b, del.cookie))) throw new Error("the deleted user row or session is still there");
      if (config.storage && r2Keys().some((k) => k.startsWith(`users/${del.id}/`))) throw new Error("the deleted user's files are still in R2");
      await noMail(doomed);
      if (rows("onboarding_step", "SELECT 1 FROM onboarding_step WHERE user_id = ?", del.id).length) throw new Error("onboarding rows survived the user's deletion");
      console.log("gate: admin delete removes the user's onboarding rows");
      const entry = auditRows().find((r) => r.verb === "delete-user");
      if (!entry || entry.target_user_id !== null || entry.target_email !== null || entry.actor_email !== boss || !String(entry.detail).includes(del.id)) throw new Error(`the delete audit entry is wrong: ${JSON.stringify(entry)}`);
      if (!auditRows().some((r) => r.verb === "ban" && r.target_email === null && r.detail === null && r.target_user_id === null)) throw new Error("the deleted user's earlier audit rows were not redacted to a null email and detail");
      if (!auditRows().some((r) => r.verb === "set-override" && r.target_email === null && r.detail === "example-feature")) throw new Error("deleting a user erased the feature name from their override entry");
      console.log("gate: admin delete removes the user row, sessions" + (config.storage ? " and files" : "") + "; no audit entry holds the deleted email or free text; the delete entry has no target");

      // Audit page: newest first, filter by the affected user, "View audit log" on user detail.
      const audit = await html(b, "/admin/audit", bossU.cookie);
      for (const t of ["<caption>", 'scope="col"', "<time datetime=", `${boss} unbanned ${victim}`, `${boss} banned ${victim}: active → banned (spam signup)`, `${boss} deleted a user`]) if (!audit.text.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
      if (audit.text.indexOf(`${boss} unbanned ${victim}`) > audit.text.indexOf(`${boss} banned ${victim}`)) throw new Error("the audit log is not newest first");
      const mine = await html(b, `/admin/audit?user=${encodeURIComponent(victim.toUpperCase())}`, bossU.cookie);
      if (!mine.text.includes(`${boss} banned ${victim}`) || mine.text.includes("deleted a user") || mine.text.includes("a deleted user")) throw new Error("?user= did not filter to the affected user");
      if (!(await html(b, `/admin/audit?user=nobody-here`, bossU.cookie)).text.includes("No changes for nobody-here.")) throw new Error("the empty filtered audit copy is missing");
      if (!(await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text.includes(`/admin/audit?user=${encodeURIComponent(victim)}`)) throw new Error("user detail lacks the View audit log link");
      console.log("gate: admin audit log newest first, ?user= filters to the affected user, user detail links to it");
      // Without --payments, nothing billing-related appears in the admin pages (#85).
      if (!config.payments) {
        const detail = (await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text, features = (await html(b, "/admin/features", bossU.cookie)).text;
        if (/billing|Stripe/i.test(detail) || features.includes("Also on for")) throw new Error("an app without --payments shows billing on the admin user or Features page");
        console.log("gate: admin without --payments: no billing section on user detail, no plan text on Features");
      }

      // The Account page: an Admin link for an admin; a verify hint for a listed, unverified user (never a different 404); nothing for anyone else.
      const acct = (cookie: string) => html(b, "/settings", cookie).then((r) => r.text);
      if (!(await acct(bossU.cookie)).includes('href="/admin"')) throw new Error("an admin's Account page lacks the Admin link");
      if ((await acct(plainU.cookie)).includes('href="/admin"') || (await acct(plainU.cookie)).includes("admin list")) throw new Error("a non-admin's Account page mentions admin");
      if (ownerU && !(await acct(ownerU.cookie)).includes("Your email is on the admin list but isn't verified yet.")) throw new Error("a listed, unverified user's Account page lacks the hint");

      // Onboarding (E14): "signed up" and "email verified" come from the user row, declared steps from onboarding_step; the list shows "n of m" and user detail the steps.
      const steps = 3; // signed up, email verified, and the scaffold's one declared step
      const listed = await html(b, `/admin?q=${encodeURIComponent(other)}`, bossU.cookie);
      if (!listed.text.includes('<th scope="col" class="wide">Onboarding</th>') || !listed.text.includes(`>2 of ${steps}</td>`)) throw new Error("the Users list lacks the Onboarding column or a verified user's 2 of 3");
      onUser(other, "INSERT INTO onboarding_step (user_id, step, reached_at) VALUES (?, 'example-step', 1700000000000)");
      if (!(await html(b, `/admin?q=${encodeURIComponent(other)}`, bossU.cookie)).text.includes(`>${steps} of ${steps}</td>`)) throw new Error("a reached step did not show 3 of 3 in the list");
      const otherPage = (await html(b, `/admin/users/${otherU.id}`, bossU.cookie)).text;
      for (const t of [`Onboarding: ${steps} of ${steps}`, "Signed up: Done", "Email verified: Done", "example-step: Done"]) if (!otherPage.includes(t)) throw new Error(`user detail lacks ${t}`);
      if (!(await html(b, `/admin/users/${victimU.id}`, bossU.cookie)).text.includes("example-step: Not yet")) throw new Error("an unreached step did not say Not yet");
      console.log(`gate: admin onboarding: the Users list shows "n of m" (2 of ${steps}, then ${steps} of ${steps} after a step), user detail lists the steps with Done and Not yet`);

      // Feature switches (#54): precedence over HTTP. The scaffold declares "example-feature" and gates routes/api/example-feature.ts on it.
      {
        const F = "example-feature", feat = addr("feat"), featU = await mk(b, feat);
        const gated = (cookie = "") => call(b, "GET", "/api/example-feature", cookie);
        const setGlobal = (state: unknown) => call(b, "POST", `/api/admin/features/${F}`, bossU.cookie, { state });
        const setUser = (u: { id: string }, state: unknown) => call(b, "POST", `/api/admin/users/${u.id}/features/${F}`, bossU.cookie, { state });
        const expectGate = async (what: string, who: string, cookie: string, want: number) => {
          const got = (await gated(cookie)).status;
          if (got !== want) throw new Error(`features: ${what}: ${who} got ${got}, expected ${want}`);
        };
        const auditCount = () => auditRows().length;
        // Nothing set: off for everyone; signed out is 401, signed in is 403.
        await expectGate("nothing set", "signed out", "", 401);
        await expectGate("nothing set", "a user", featU.cookie, 403);
        // Global on and off.
        if ((await setGlobal("on")).status !== 200) throw new Error("features: setting the global state on failed");
        await expectGate("global on", "a user", featU.cookie, 200);
        await expectGate("global on", "signed out", "", 401);
        const onBody = (await (await gated(featU.cookie)).json()) as { features: string[] };
        if (!onBody.features.includes(F)) throw new Error("features(c) did not list a feature that is on");
        if ((await setGlobal("off")).status !== 200) throw new Error("features: setting the global state off failed");
        await expectGate("global off", "a user", featU.cookie, 403);
        // An override in both directions: on beats global off for that user only; off beats global on.
        if ((await setUser(featU, "on")).status !== 200) throw new Error("features: setting an override on failed");
        await expectGate("override on, global off", "the user", featU.cookie, 200);
        await expectGate("override on, global off", "another user", plainU.cookie, 403);
        await setGlobal("on");
        if ((await setUser(featU, "off")).status !== 200) throw new Error("features: setting an override off failed");
        await expectGate("override off, global on", "the user", featU.cookie, 403);
        await expectGate("override off, global on", "another user", plainU.cookie, 200);
        // The kill switch beats an override on, for everyone.
        await setUser(featU, "on");
        await expectGate("override on, global on", "the user", featU.cookie, 200);
        if ((await setGlobal("kill")).status !== 200) throw new Error("features: setting the kill switch failed");
        await expectGate("kill switch", "the user with an override on", featU.cookie, 403);
        await expectGate("kill switch", "another user", plainU.cookie, 403);
        // The pages show the result and the reason, computed by decide().
        const killed = (await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text;
        for (const t of ["Feature overrides", "Use global", `id="override-${F}"`, "Effective: Off: kill switch applies to everyone", `aria-label="Save ${F} for ${feat}"`]) if (!killed.includes(t)) throw new Error(`user detail lacks ${t} under the kill switch`);
        await setGlobal("on");
        if (!(await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text.includes("Effective: On: user override")) throw new Error("user detail does not say On: user override");
        await setUser(featU, "default");
        if (!(await html(b, `/admin/users/${featU.id}`, bossU.cookie)).text.includes("Effective: On: on for everyone")) throw new Error("user detail does not follow the global state once the override is reset");
        await expectGate("override reset, global on", "the user", featU.cookie, 200);
        const page = (await html(b, "/admin/features", bossU.cookie)).text;
        for (const t of ["<h1", F, "<fieldset>", "<legend", 'type="radio"', "Everyone, except users set to off", "No one, except users set to on", "No one. User settings are ignored.", `aria-label="Save ${F}"`, 'href="/admin/features"']) if (!page.includes(t)) throw new Error(`/admin/features lacks ${t}`);
        console.log("gate: features: nothing set is off (401 signed out, 403 signed in), global on and off, an override in both directions, the kill switch beats an override on, and the pages show the effective result and reason");
        // A row for a feature that is no longer declared is dropped: it neither reaches features(c) nor the pages, and nothing fails.
        onUser(feat, "INSERT INTO feature_switch (feature, state, updated_at) SELECT 'ghost', 'on', 1700000000000 WHERE ? IS NOT NULL");
        onUser(feat, "INSERT INTO feature_override (user_id, feature, state, updated_at) VALUES (?, 'ghost', 'on', 1700000000000)");
        const ghost = (await (await gated(featU.cookie)).json()) as { features: string[] };
        if (ghost.features.join() !== F) throw new Error(`features(c) with an undeclared row returned ${ghost.features.join()}`);
        const ghostPage = await html(b, "/admin/features", bossU.cookie), ghostUser = await html(b, `/admin/users/${featU.id}`, bossU.cookie);
        if (ghostPage.status !== 200 || ghostUser.status !== 200 || ghostPage.text.includes("ghost") || ghostUser.text.includes("ghost")) throw new Error("an undeclared feature row reached a page");
        if ((await setGlobal("on")).status !== 200) throw new Error("an undeclared row broke set()");
        console.log("gate: features: an undeclared feature row and override are dropped");
        // Refusals write nothing: a bad state, an undeclared feature, a missing user, a non-admin, no or a foreign Origin.
        const before = auditCount();
        const refused: [string, number][] = [
          [`bad state: ${(await setGlobal("sometimes")).status}`, 400],
          [`no state: ${(await setGlobal(undefined)).status}`, 400],
          [`kill as an override: ${(await setUser(featU, "kill")).status}`, 400],
          [`undeclared feature: ${(await call(b, "POST", "/api/admin/features/ghost", bossU.cookie, { state: "on" })).status}`, 400],
          [`missing user: ${(await call(b, "POST", `/api/admin/users/not-a-user/features/${F}`, bossU.cookie, { state: "on" })).status}`, 404],
          [`non-admin global: ${(await call(b, "POST", `/api/admin/features/${F}`, plainU.cookie, { state: "off" })).status}`, 404],
          [`non-admin override: ${(await call(b, "POST", `/api/admin/users/${featU.id}/features/${F}`, plainU.cookie, { state: "off" })).status}`, 404],
          [`signed out: ${(await call(b, "POST", `/api/admin/features/${F}`, "", { state: "off" })).status}`, 404],
          [`foreign Origin: ${(await fetch(`${b}/api/admin/features/${F}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", cookie: bossU.cookie }, body: JSON.stringify({ state: "off" }) })).status}`, 403],
          [`no Origin: ${(await fetch(`${b}/api/admin/features/${F}`, { method: "POST", headers: { "content-type": "application/json", cookie: bossU.cookie }, body: JSON.stringify({ state: "off" }) })).status}`, 403],
        ];
        // A foreign Origin is 403 or 404 (Better Auth ignores the session cookie on it, so the admin looks signed out); either way nothing runs.
        for (const [what, want] of refused) if (Number(what.split(": ")[1]) !== want && !(what.startsWith("foreign Origin") && what.endsWith("404"))) throw new Error(`features: ${what}, expected ${want}`);
        await expectGate("after the refusals", "the user", featU.cookie, 200);
        if (auditCount() !== before) throw new Error("a refused feature change wrote an audit entry");
        if ((await html(b, "/admin/features", plainU.cookie)).status !== 404) throw new Error("a non-admin reached /admin/features");
        console.log("gate: features: a bad state, an undeclared feature, a missing user, a non-admin and a missing or foreign Origin are refused and write no audit entry");
        // Every change is audited, in the same batch as the change, with the old and new value.
        const audited = auditRows().filter((r) => r.verb === "set-feature" || r.verb === "set-override");
        const has = (verb: string, old: string, now: string) => audited.some((r) => r.verb === verb && r.detail === F && r.old_value === old && r.new_value === now);
        if (!has("set-feature", "off", "on") || !has("set-feature", "on", "kill") || !has("set-override", "default", "on") || !has("set-override", "on", "default") || !has("set-override", "on", "off")) throw new Error(`features: the audit log lacks an entry: ${JSON.stringify(audited.map((r) => [r.verb, r.old_value, r.new_value]))}`);
        if (!audited.some((r) => r.verb === "set-override" && r.target_email === feat)) throw new Error("an override entry does not name the user");
        const log = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} set feature ${F}: on → kill`, `${boss} set feature ${F} for ${feat}: default → on`]) if (!log.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
        console.log("gate: features: every global change and override wrote an audit entry with its old and new value");
      }

      // Settings (#55): typed runtime settings. The scaffold declares four examples (text, number 1..100 default 10, on/off, a choice) and routes/api/example-settings.ts reads them.
      {
        const N = "example-number", set = (key: string, value: unknown, cookie = bossU.cookie) => call(b, "POST", `/api/admin/settings/${key}`, cookie, { value });
        const del = (key: string, cookie = bossU.cookie) => call(b, "DELETE", `/api/admin/settings/${key}`, cookie);
        const read = async () => (await (await call(b, "GET", "/api/example-settings", plainU.cookie)).json()) as { text: string; number: number; toggle: boolean; choice: string };
        const changes = () => auditRows().filter((r) => r.verb === "set-setting" || r.verb === "reset-setting");
        const need = (cond: boolean, what: string) => { if (!cond) throw new Error(`settings: ${what}`); };
        const SAVED_COPY = "Saved. Applies on the user's next page load.";
        // Nothing stored: every getter returns its declared default. Signed out is 401.
        need((await call(b, "GET", "/api/example-settings")).status === 401, "the example route answered a signed-out request");
        need(JSON.stringify(await read()) === JSON.stringify({ text: "Hello", number: 10, toggle: false, choice: "medium" }), "the getters did not return the declared defaults");
        let page = (await html(b, "/admin/settings", bossU.cookie)).text;
        for (const t of ["<h1", 'href="/admin/settings"', N, "A number between 1 and 100.", "Default: 10", "Default: Off", "Default: medium", "Default: Hello", 'type="number"', 'min="1"', 'max="100"', 'type="checkbox"', "<select", `aria-label="Save ${N}"`, "<form"]) need(page.includes(t), `/admin/settings lacks ${t}`);
        need(!page.includes("Reset to default") && !page.includes("Stored value is invalid"), "the page offered a reset with nothing stored");
        // Save: the value is read back, the page offers a reset, and the audit entry has the old and new value.
        const saved = await set(N, 25);
        need(saved.status === 200 && ((await saved.json()) as { message: string }).message === SAVED_COPY, "saving a number did not answer 200 with the success copy");
        need((await read()).number === 25, "the getter did not return the saved number");
        need((await set("example-text", "Hi there")).status === 200 && (await set("example-toggle", true)).status === 200 && (await set("example-choice", "large")).status === 200, "saving a text, an on/off and a choice setting failed");
        const now = await read();
        need(now.text === "Hi there" && now.toggle === true && now.choice === "large", `the getters returned ${JSON.stringify(now)} after saving every type`);
        page = (await html(b, "/admin/settings", bossU.cookie)).text;
        need(page.includes(`aria-label="Reset ${N} to default"`) && page.includes("Reset to default") && page.includes('value="25"'), "the page does not show the saved number and its Reset to default");
        const logged = (verb: string, key: string, old: string, now: string) => changes().some((r) => r.verb === verb && r.detail === key && r.old_value === old && r.new_value === now);
        need(logged("set-setting", N, "10", "25") && logged("set-setting", "example-toggle", "false", "true") && logged("set-setting", "example-choice", "medium", "large"), `the audit log lacks a save: ${JSON.stringify(changes().map((r) => [r.verb, r.detail, r.old_value, r.new_value]))}`);
        // Saving the value a setting already has answers 200 and writes no audit entry.
        {
          const n0 = auditRows().length;
          need((await set(N, 25)).status === 200 && (await set("example-toggle", true)).status === 200, "a save of the current value did not answer 200");
          need(auditRows().length === n0, `a save of the current value wrote ${auditRows().length - n0} audit entries`);
        }
        console.log("gate: settings: the getters return the declared defaults, a save of each type is read back, shown with its reset, and audited with the old and new value");
        // Refusals: out of range 400 (both ends), a wrong type, an undeclared key, a missing user's rights, no or a foreign Origin. Nothing is written and the value stands.
        const before = auditRows().length;
        const fetchOrigin = (method: string, key: string, origin?: string) => fetch(`${b}/api/admin/settings/${key}`, { method, headers: { ...(origin && { origin }), "content-type": "application/json", cookie: bossU.cookie }, body: method === "POST" ? JSON.stringify({ value: 30 }) : undefined });
        const refused: [string, number, number | number[]][] = [
          ["number over the max", (await set(N, 101)).status, 400],
          ["number under the min", (await set(N, 0)).status, 400],
          ["number as text", (await set(N, "abc")).status, 400],
          ["number missing", (await call(b, "POST", `/api/admin/settings/${N}`, bossU.cookie, {})).status, 400],
          ["on/off as text", (await set("example-toggle", "maybe")).status, 400],
          ["choice outside the set", (await set("example-choice", "huge")).status, 400],
          ["text over 1000 characters", (await set("example-text", "x".repeat(1001))).status, 400],
          ["undeclared key", (await set("ghost", 1)).status, 400],
          ["undeclared key reset", (await del("ghost")).status, 400],
          ["non-admin save", (await set(N, 30, plainU.cookie)).status, 404],
          ["non-admin reset", (await del(N, plainU.cookie)).status, 404],
          ["signed-out save", (await set(N, 30, "")).status, 404],
          ["no Origin save", (await fetchOrigin("POST", N)).status, 403],
          ["no Origin reset", (await fetchOrigin("DELETE", N)).status, 403],
          ["foreign Origin save", (await fetchOrigin("POST", N, "https://evil.test")).status, [403, 404]],
          ["foreign Origin reset", (await fetchOrigin("DELETE", N, "https://evil.test")).status, [403, 404]],
        ];
        for (const [what, got, want] of refused) if (Array.isArray(want) ? !want.includes(got) : got !== want) throw new Error(`settings: ${what} answered ${got}, expected ${want}`);
        const refusal = (await set(N, 101).then((r) => r.json())) as { message: string };
        need(refusal.message === "Enter a number from 1 to 100.", `the out-of-range message was "${refusal.message}"`);
        need((await read()).number === 25 && auditRows().length === before, "a refused setting change wrote an audit entry or changed the value");
        need((await html(b, "/admin/settings", plainU.cookie)).status === 404, "a non-admin reached /admin/settings");
        console.log("gate: settings: an out-of-range number, a wrong type, a value outside the set, an undeclared key, a non-admin and a missing or foreign Origin are refused and write no audit entry");
        // Reset to the default: one entry, the getter returns the default again, the page stops offering the reset. A second reset has nothing to do and writes nothing.
        const n = changes().length;
        need((await del(N)).status === 200 && (await read()).number === 10, "reset did not restore the default");
        need(changes().length === n + 1 && logged("reset-setting", N, "25", "10"), "reset did not write exactly one audit entry");
        need(!(await html(b, "/admin/settings", bossU.cookie)).text.includes(`aria-label="Reset ${N} to default"`), "the page still offers a reset at the default");
        const again = await del(N);
        need(again.status === 404 && changes().length === n + 1, `a reset at the default answered ${again.status} or wrote an entry`);
        // Two resets of one setting at once: one wins and writes one entry, the other answers 404 and writes nothing.
        await set(N, 30);
        const m = changes().length;
        const race = (await Promise.all([del(N), del(N)])).map((r) => r.status).sort();
        need(race.join() === "200,404" && changes().length === m + 1 && (await read()).number === 10, `two concurrent resets answered ${race.join()} and left ${changes().length - m} entries`);
        console.log("gate: settings: reset restores the default with one audit entry, a reset at the default and the loser of two concurrent resets write nothing");
        // A stored value that no longer fits (here out of range, as after a declaration changed) reads as the default and says so; reset clears it. A row for an undeclared key is dropped.
        onUser(boss, "INSERT OR REPLACE INTO setting (key, value, updated_at) SELECT 'example-number', '999', 1700000000000 WHERE ? IS NOT NULL");
        onUser(boss, "INSERT OR REPLACE INTO setting (key, value, updated_at) SELECT 'ghost', 'x', 1700000000000 WHERE ? IS NOT NULL");
        need((await read()).number === 10, "an out-of-range stored value was returned instead of the default");
        const stale = (await html(b, "/admin/settings", bossU.cookie)).text;
        need(stale.includes("Stored value is invalid; using the default.") && stale.includes(`aria-label="Reset ${N} to default"`) && !stale.includes("ghost"), "the page did not flag the stored value as invalid, or showed an undeclared row");
        need((await del(N)).status === 200 && !(await html(b, "/admin/settings", bossU.cookie)).text.includes("Stored value is invalid"), "reset did not clear the invalid stored value");
        const log = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} set setting ${N}: 10 → 25`, `${boss} reset setting ${N}: 25 → 10`]) need(log.includes(t), `/admin/audit lacks ${t}`);
        console.log("gate: settings: an invalid stored value reads as the default and is flagged, an undeclared row is dropped, and the audit log reads \"set setting\" and \"reset setting\"");
      }

      if (config.inviteOnly) {
        // Invites in the database (U4, E10): no SIGNUP_ALLOWLIST at all, so the database is the only list and the app still fails closed.
        b = await withAdmins(boss, null);
        const invitedMail = addr("invited"), refusedMail = addr("neither"), domainMail = `dom-${ts}@corp.test`, revokedMail = addr("revoked"), pendMail = addr("pend"), ghostIn = addr("ghostin"), ghostOut = `ghost-${ts}@nowhere.test`;
        const api = (method: string, path: string, cookie = bossU.cookie, body?: object) => call(b, method, path, cookie, body);
        const addInvite = (kind: string, value: string) => api("POST", "/api/admin/invites", bossU.cookie, { kind, value });
        const inviteId = (entry: string) => String(rows("invite", "SELECT id FROM invite WHERE entry = ?", entry.toLowerCase())[0]?.id);
        const said = async (r: Response) => (await r.json()) as { message: string; notes?: string[] };
        if (!(await html(b, "/admin/invites", bossU.cookie)).text.includes("Invites you add here appear below.")) throw new Error("the empty Invites page lacks its empty state");
        await inviteRefused(b, refusedMail); // neither source: refused
        const add = await addInvite("email", invitedMail.toUpperCase());
        if (add.status !== 200 || (await said(add)).message !== `Invited ${invitedMail}.`) throw new Error(`add invite -> ${add.status}`);
        await signUpVerified(b, invitedMail); // admitted at once, no restart
        const domain = await addInvite("domain", "Corp.Test");
        if (domain.status !== 200 || (await said(domain)).message !== "Invited anyone at @corp.test.") throw new Error(`add domain invite -> ${domain.status}`);
        await signUpVerified(b, domainMail);
        for (const a of [`x-${ts}@sub.corp.test`, `x-${ts}@evilcorp.test`, `x-${ts}@corp.test.evil.test`]) await inviteRefused(b, a);
        // Validation, duplicates, and who may call it.
        if ((await addInvite("email", "not-an-email")).status !== 400 || (await addInvite("domain", "a@x.com")).status !== 400 || (await addInvite("email", invitedMail)).status !== 409) throw new Error("a bad or duplicate invite was not refused 400 / 409");
        for (const [who, cookie] of [["signed out", ""], ["non-admin", plainU.cookie]] as const)
          for (const [method, path] of [["GET", "/admin/invites"], ["POST", "/api/admin/invites"], ["POST", `/api/admin/invites/${inviteId(invitedMail)}/revoke`], ["POST", `/api/admin/invites/${inviteId(invitedMail)}/send`]] as const)
            if ((await api(method, path, cookie, method === "POST" ? { kind: "email", value: addr("x") } : undefined)).status !== 404) throw new Error(`${who}: ${method} ${path} was not 404`);
        const evilOrigin = await fetch(`${b}/api/admin/invites`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", cookie: bossU.cookie }, body: JSON.stringify({ kind: "email", value: addr("evil") }) });
        // No Origin: our 403. A foreign Origin: Void drops the session before our route runs (404); our 403 is the backstop. Either way nothing is added.
        const noOrigin = await fetch(`${b}/api/admin/invites`, { method: "POST", headers: { "content-type": "application/json", cookie: bossU.cookie }, body: JSON.stringify({ kind: "email", value: addr("evil") }) });
        if (noOrigin.status !== 403 || ![403, 404].includes(evilOrigin.status) || rows("invite", "SELECT 1 FROM invite WHERE entry LIKE 'evil-%'").length) throw new Error(`add invite with no Origin -> ${noOrigin.status}, a foreign one -> ${evilOrigin.status}`);
        console.log("gate: admin invites with no SIGNUP_ALLOWLIST: an exact and a domain invite admit at once without a restart, a lookalike and no source are refused, bad input 400, duplicate 409, non-admin 404, no or foreign Origin refused");

        // Revoke: refused again; the existing account is untouched; the notes.
        await addInvite("email", revokedMail);
        const revoked = await api("POST", `/api/admin/invites/${inviteId(revokedMail)}/revoke`);
        const revokedBody = await said(revoked);
        if (revoked.status !== 200 || revokedBody.message !== "Invite removed." || revokedBody.notes?.join("|") !== "Existing accounts are not affected. Ban the user to block them.") throw new Error(`revoke -> ${revoked.status} ${JSON.stringify(revokedBody)}`);
        await inviteRefused(b, revokedMail);
        if ((await api("POST", `/api/admin/invites/${inviteId(invitedMail)}/revoke`)).status !== 200 || !(await signIn(b, invitedMail)).ok) throw new Error("revoking an invite touched the existing account");
        if ((await api("POST", "/api/admin/invites/does-not-exist/revoke")).status !== 404) throw new Error("revoking a missing invite was not 404");
        console.log("gate: admin invite revoke: refused again, the existing account still signs in, the note says existing accounts are not affected");

        // The reset-password re-check reads the database: a pending user's set-password link stops working when their database invite is revoked.
        await addInvite("email", pendMail);
        await authPost(b, "/api/auth/sign-up/email", { name: "Gate", email: pendMail, password: "" });
        const [pendLink] = await waitMails(b, SET_PW, pendMail, 1);
        if (!pendLink) throw new Error("no set-password mail for a database-invited sign-up");
        await api("POST", `/api/admin/invites/${inviteId(pendMail)}/revoke`);
        const pendSet = await setPassword(b, pendLink, "pending-password-1");
        if (pendSet.ok || isVerified(pendMail)) throw new Error(`a revoked pending user's set-password link -> ${pendSet.status}, verified ${isVerified(pendMail)}`);
        console.log("gate: admin invite: the reset-password re-check reads the database (a revoked pending user's link is refused and does not verify)");

        // Send invite: mail for an exact email, nothing for a domain.
        const sendTo = addr("sendto");
        await addInvite("email", sendTo);
        const sentInvite = await api("POST", `/api/admin/invites/${inviteId(sendTo)}/send`);
        if (sentInvite.status !== 200 || (await said(sentInvite)).message !== `Invite email requested for ${sendTo}.`) throw new Error(`send invite -> ${sentInvite.status}`);
        const [inviteMail] = await waitMails(b, `Your invitation to ${new URL(b).host}`, sendTo, 1);
        if (!inviteMail || inviteMail.pathname !== "/sign-up") throw new Error(`the invite mail is missing or does not link to /sign-up: ${inviteMail}`);
        if ((await api("POST", `/api/admin/invites/${inviteId("@corp.test")}/send`)).status !== 400) throw new Error("send invite for a domain was not 400");
        console.log("gate: admin send-invite mails the sign-up link to an exact email and refuses a domain");
        // A resend inside a minute is refused (429) and neither mails nor records anything.
        const resend = await api("POST", `/api/admin/invites/${inviteId(sendTo)}/send`);
        if (resend.status !== 429 || (await said(resend)).message !== "An invite was just sent. Try again in a minute.") throw new Error(`a resend within a minute -> ${resend.status}`);
        if (auditRows().filter((r) => r.verb === "send-invite" && r.target_email === sendTo).length !== 1) throw new Error("a refused resend wrote an audit entry");
        console.log("gate: admin send-invite refuses a resend within a minute (429) and records nothing");
        // Four sends at once: the slot is claimed before mailing, so exactly one mails and records; the rest are 429.
        const burstTo = addr("burst");
        await addInvite("email", burstTo);
        const burst = await Promise.all(Array.from({ length: 4 }, () => api("POST", `/api/admin/invites/${inviteId(burstTo)}/send`).then((r) => r.status)));
        if (burst.filter((s) => s === 200).length !== 1 || burst.filter((s) => s === 429).length !== 3) throw new Error(`four concurrent sends -> ${burst}, expected one 200 and three 429`);
        if (auditRows().filter((r) => r.verb === "send-invite" && r.target_email === burstTo).length !== 1) throw new Error("four concurrent sends did not write exactly one send-invite entry");
        console.log("gate: admin send-invite: four sends at once mail and record once (the rest 429)");

        // Concurrent requests: four revokes of one invite write exactly one entry (the others are 404); four adds of one entry make one row and one entry (the others are 409, never 500).
        const raceMail = addr("race"), dupMail = addr("dup"), viaDomain = `via-${ts}@corp.test`;
        await addInvite("email", raceMail);
        const raceId = inviteId(raceMail);
        const revokes = await Promise.all([1, 2, 3, 4].map(() => api("POST", `/api/admin/invites/${raceId}/revoke`)));
        const adds = await Promise.all([1, 2, 3, 4].map(() => addInvite("email", dupMail)));
        const tally = (rs: Response[]) => rs.map((r) => r.status).sort().join();
        if (tally(revokes) !== "200,404,404,404") throw new Error(`four concurrent revokes -> ${tally(revokes)}`);
        if (tally(adds) !== "200,409,409,409") throw new Error(`four concurrent adds -> ${tally(adds)}`);
        const count = (verb: string, target: string) => auditRows().filter((r) => r.verb === verb && r.target_email === target).length;
        if (count("revoke-invite", raceMail) !== 1 || count("invite", dupMail) !== 1 || rows("invite", "SELECT 1 FROM invite WHERE entry = ?", dupMail).length !== 1) throw new Error("concurrent requests wrote more than one entry or row");
        console.log("gate: admin invites under concurrency: four revokes write one entry (the rest 404), four duplicate adds make one row and one entry (the rest 409)");

        // Revoking an exact email that a remaining domain invite still admits says so.
        await addInvite("email", viaDomain);
        const viaBody = await said(await api("POST", `/api/admin/invites/${inviteId(viaDomain)}/revoke`));
        if (viaBody.notes?.join("|") !== "Still invited through @corp.test.|Existing accounts are not affected. Ban the user to block them.") throw new Error(`revoke under a domain invite -> ${JSON.stringify(viaBody)}`);
        console.log("gate: admin invite revoke of an email covered by a domain invite says Still invited through @corp.test.");

        // Every change wrote its audit entry (same batch), and the audit page words them.
        for (const [verb, target] of [["invite", invitedMail], ["invite", "@corp.test"], ["revoke-invite", revokedMail], ["send-invite", sendTo]] as const)
          if (!auditRows().some((r) => r.verb === verb && r.target_email === target && r.actor_email === boss)) throw new Error(`no ${verb} audit entry for ${target}`);
        const invAudit = (await html(b, "/admin/audit", bossU.cookie)).text;
        for (const t of [`${boss} invited ${invitedMail}`, `${boss} removed the invite for ${revokedMail}`, `${boss} requested an invite email for ${sendTo}`]) if (!invAudit.includes(t)) throw new Error(`/admin/audit lacks ${t}`);
        console.log("gate: admin invite add, revoke and send each wrote an audit entry");

        // The page, and the Users search for an address with no account.
        const invPage = (await html(b, `/admin/invites?email=${encodeURIComponent(ghostOut)}`, bossU.cookie)).text;
        for (const t of ["Exact email", "Whole domain", "<caption>", 'scope="col"', `aria-label="Revoke ${sendTo}"`, `aria-label="Send invite email to ${sendTo}"`, "@corp.test", "From the SIGNUP_ALLOWLIST secret (edit the secret to change)", "The secret is empty.", `value="${ghostOut}"`]) if (!invPage.includes(t)) throw new Error(`/admin/invites lacks ${t}`);
        if (invPage.includes('aria-label="Send invite email to @corp.test"')) throw new Error("a domain row offers Send invite");
        if (!(await html(b, "/admin", bossU.cookie)).text.includes('href="/admin/invites"')) throw new Error("the admin nav lacks Invites");
        await addInvite("email", ghostIn);
        const notInvited = (await html(b, `/admin?q=${encodeURIComponent(ghostOut)}`, bossU.cookie)).text;
        for (const t of [`No account for ${ghostOut}.`, `${ghostOut} is not invited.`, `/admin/invites?email=${encodeURIComponent(ghostOut)}`, "Invite them"]) if (!notInvited.includes(t)) throw new Error(`the not-invited search lacks ${t}`);
        const invitedNoAccount = (await html(b, `/admin?q=${encodeURIComponent(ghostIn)}`, bossU.cookie)).text;
        if (!invitedNoAccount.includes(`No account for ${ghostIn}.`) || !invitedNoAccount.includes("Invited, but hasn't signed up yet.") || invitedNoAccount.includes("is not invited")) throw new Error("the invited-but-no-account search lacks its copy");
        console.log("gate: admin Invites page lists what was added (domain rows have no Send invite), a search with no account says not invited with an Invite them link, or invited but not signed up");

        // The secret still admits, is shown read-only, and revoking a covered entry says so.
        const secretMail = `secret-${ts}@partner.test`;
        b = await withAdmins(boss, secretMail.toUpperCase());
        await signUpVerified(b, secretMail);
        await signUpVerified(b, `dom2-${ts}@corp.test`); // the database invite still admits beside the secret
        await inviteRefused(b, `other-${ts}@partner.test`);
        if (!(await html(b, "/admin/invites", bossU.cookie)).text.includes(`<li>${secretMail}</li>`)) throw new Error("the secret's entry is not listed read-only");
        await addInvite("email", secretMail);
        const covered = await api("POST", `/api/admin/invites/${inviteId(secretMail)}/revoke`);
        const coveredBody = await said(covered);
        if (covered.status !== 200 || coveredBody.notes?.[0] !== "Still invited through SIGNUP_ALLOWLIST.") throw new Error(`revoking a secret-covered invite -> ${covered.status} ${JSON.stringify(coveredBody)}`);
        console.log("gate: admin invites with a SIGNUP_ALLOWLIST: a secret entry still admits beside the database, is listed read-only, and revoking a covered invite says Still invited through SIGNUP_ALLOWLIST.");
        b = await withAdmins(`${boss},${owner2}`);
      }

      // De-listed on a live session and an empty list. Restart on a list without boss (and with plain): boss's session is 404 on page and API at once; plain's live session now reaches list-users.
      b = await withAdmins(plain);
      await expectAll(b, "de-listed admin", bossU.cookie, victimU.id, () => 404);
      for (const [m, p] of adminPaths(victimU.id).slice(0, 5)) if ((await call(b, m, p, plainU.cookie, m === "POST" ? { userId: victimU.id } : undefined)).status !== (p === "/admin/users" ? 302 : 200)) throw new Error(`a newly listed user's live session: ${m} ${p} was refused`);
      b = await withAdmins("");
      const empty = await call(b, "GET", "/admin", plainU.cookie), root = await call(b, "GET", "/");
      if (empty.status !== 404 || root.status !== 200) throw new Error(`an empty ADMIN_EMAILS: /admin -> ${empty.status}, / -> ${root.status}`);
      if ((await call(b, "GET", "/api/auth/admin/list-users", plainU.cookie)).status !== 404) throw new Error("list-users answered with an empty ADMIN_EMAILS");
      console.log("gate: admin follows ADMIN_EMAILS live: a de-listed session is 404 on pages and API, a newly listed one is let in on its existing session, an empty list is 404 while GET / is 200");
    } finally {
      writeFileSync(envFile, original);
    }
  }
  // --payments: the app against a fake Stripe over HTTP (STRIPE_API_URL), with webhooks the gate signs itself (Web Crypto HMAC, as Stripe does).
  const paymentsGate = async () => {
    const envFile = join(app, ".env"), original = readFileSync(envFile, "utf8");
    const check = (ok: unknown, what: string) => { if (!ok) throw new Error(`payments: ${what}`); };
    // The fake answers exactly what the app and the plugin call; every request is recorded.
    type Obj = Record<string, any>;
    const fake = { customers: new Map<string, Obj>(), prices: new Map<string, Obj>(), sessions: new Map<string, Obj>(), subs: new Map<string, Obj>(), portals: 0, calls: [] as string[], n: 0, down: "" as "" | "all" | "cancel" };
    const id = (p: string) => `${p}_gate${++fake.n}`;
    // Stripe's form encoding (`metadata[userId]=…`, `line_items[0][price]=…`) read into nested objects.
    const form = (text: string): Obj => {
      const out: Obj = {};
      for (const [k, v] of new URLSearchParams(text)) {
        const path = k.replace(/\]/g, "").split("[");
        let o = out;
        path.slice(0, -1).forEach((p) => (o = o[p] ??= {}));
        o[path.at(-1)!] = v;
      }
      return out;
    };
    const missing = () => Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } }, { status: 404 });
    const list = (data: Obj[]) => Response.json({ object: "list", data, has_more: false, url: "/v1/x" });
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url), p = url.pathname, m = req.method;
        fake.calls.push(`${m} ${p}`);
        // An outage: every call fails ("all"), or only cancelling a subscription does ("cancel").
        if (fake.down === "all" || (fake.down === "cancel" && m === "DELETE")) return Response.json({ error: { type: "api_error", message: "fake Stripe is down" } }, { status: 500 });
        const body = m === "POST" ? form(await req.text()) : {};
        let r: RegExpMatchArray | null;
        if (m === "GET" && p === "/v1/customers/search") return Response.json({ object: "search_result", data: [], has_more: false, url: p });
        if (m === "POST" && p === "/v1/customers") { const c = { id: id("cus"), object: "customer", email: body.email, name: body.name, metadata: body.metadata ?? {} }; fake.customers.set(c.id, c); return Response.json(c); }
        if ((r = p.match(/^\/v1\/customers\/([^/]+)$/))) { const c = fake.customers.get(r[1]!); if (!c) return missing(); if (m === "POST") Object.assign(c, body); return Response.json(c); }
        if (m === "GET" && p === "/v1/prices") { const keys = [...url.searchParams].filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v); return list([...fake.prices.values()].filter((x) => keys.includes(x.lookup_key))); }
        if (m === "POST" && p === "/v1/prices") {
          const x = { id: id("price"), object: "price", active: true, currency: body.currency, unit_amount: Number(body.unit_amount), lookup_key: body.lookup_key, product: body.product ?? id("prod"), recurring: { interval: body.recurring?.interval, usage_type: "licensed" } };
          fake.prices.set(x.id, x);
          return Response.json(x);
        }
        if (m === "GET" && p === "/v1/subscriptions") return list([...fake.subs.values()].filter((s) => s.customer === url.searchParams.get("customer")));
        if ((r = p.match(/^\/v1\/subscriptions\/([^/]+)$/))) { const s = fake.subs.get(r[1]!); if (!s) return missing(); if (m === "DELETE") s.status = "canceled"; return Response.json(s); }
        if (m === "POST" && p === "/v1/checkout/sessions") { const s = { id: id("cs"), object: "checkout.session", url: "https://checkout.stripe.test/pay", subscription: null, payment_status: "unpaid", status: "open", ...body }; fake.sessions.set(s.id, s); return Response.json(s); }
        if (m === "GET" && p === "/v1/checkout/sessions") return list([...fake.sessions.values()].filter((x) => x.customer === url.searchParams.get("customer") && x.status === url.searchParams.get("status")));
        if (m === "POST" && (r = p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/))) { const x = fake.sessions.get(r[1]!); if (!x) return missing(); x.status = "expired"; return Response.json(x); }
        if ((r = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) { const s = fake.sessions.get(r[1]!); return s ? Response.json(s) : missing(); }
        if (m === "POST" && p === "/v1/billing_portal/sessions") { fake.portals++; return Response.json({ id: id("bps"), object: "billing_portal.session", url: "https://billing.stripe.test/session", customer: body.customer, return_url: body.return_url }); }
        return Response.json({ error: { type: "invalid_request_error", message: `fake Stripe has no ${m} ${p}` } }, { status: 404 });
      },
    });
    const SECRET = "whsec_gate_" + crypto.randomUUID().replaceAll("-", "");
    const sign = async (payload: string, secret = SECRET) => {
      const t = Math.floor(Date.now() / 1000);
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
      return `t=${t},v1=${[...mac].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    };
    // The app database: the sqlite file that has the subscription table.
    const db = <T,>(fn: (d: Database) => T): T => {
      for (const f of sqliteFiles(join(app, ".void"))) {
        const d = openDb(f);
        try {
          if (d.query("SELECT 1 FROM sqlite_master WHERE name = 'subscription'").get()) return fn(d);
        } finally { d.close(); }
      }
      throw new Error("payments: no database with a subscription table");
    };
    const subRows = (userId: string) => db((d) => d.query("SELECT * FROM subscription WHERE referenceId = ? ORDER BY id").all(userId) as Obj[]);
    const allSubs = () => db((d) => JSON.stringify(d.query("SELECT id, status, plan, referenceId, stripeSubscriptionId FROM subscription ORDER BY id").all()));
    const restart = async (vars: Record<string, string | null>) => {
      await killChildren();
      let text = original;
      for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`^${k}=.*\\n`, "m"), "") + (v === null ? "" : `${k}=${v}\n`);
      writeFileSync(envFile, text);
      return `http://localhost:${(await startDev()).port}`;
    };
    const user = async (b: string, address: string) => {
      if (config.inviteOnly) return signUpVerified(b, address);
      if (!(await authPost(b, "/api/auth/sign-up/email", { name: "Payer", email: address, password: gatePw })).ok) throw new Error(`payments: sign-up for ${address} failed`);
      const inn = await authPost(b, "/api/auth/sign-in/email", { email: address, password: gatePw });
      check(inn.ok, `sign-in for ${address} -> ${inn.status}`);
      return cookieOf(inn);
    };
    const idOf = (address: string) => onUser(address, "SELECT ?").id;
    const call = (b: string, path: string, cookie = "", body?: object, origin = b) =>
      fetch(b + path, { method: body ? "POST" : "GET", redirect: "manual", headers: { origin, ...(cookie && { cookie }), ...(body && { "content-type": "application/json" }) }, body: body && JSON.stringify(body) });
    const page = (b: string, cookie = "") => call(b, "/billing", cookie).then((r) => r.text());
    const UPGRADE = { plan: "pro", successUrl: "/billing", cancelUrl: "/billing" };
    const webhook = async (b: string, ev: Obj, sig?: string, secret = SECRET) => {
      const payload = JSON.stringify({ id: id("evt"), object: "event", api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), livemode: false, ...ev });
      return fetch(`${b}/api/auth/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig !== "" && { "stripe-signature": sig ?? (await sign(payload, secret)) }) }, body: payload });
    };
    const now = Math.floor(Date.now() / 1000);
    const subObj = (s: Obj) => ({ object: s });
    const stripeSub = (o: { id: string; customer: string; status: string; metadata?: Obj; cancel?: boolean }) => {
      const price = [...fake.prices.values()].find((x) => x.lookup_key === "pro_monthly")!;
      const s = {
        id: o.id, object: "subscription", customer: o.customer, status: o.status, metadata: o.metadata ?? {}, cancel_at_period_end: !!o.cancel, cancel_at: null, canceled_at: null, ended_at: null, trial_start: null, trial_end: null, schedule: null,
        items: { object: "list", data: [{ id: `si_${o.id}`, object: "subscription_item", quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price }] },
      };
      fake.subs.set(s.id, s);
      return s;
    };
    try {
      let b = `http://localhost:${port}`;
      // Placeholder keys (a fresh scaffold): the app serves, and subscription actions say Stripe isn't set up.
      b = await restart({});
      const early = await user(b, `payer-early-${Date.now()}@example.com`);
      check((await page(b, early)).includes("Stripe isn't set up yet."), "/billing with placeholder keys lacks \"Stripe isn't set up yet.\"");
      const unset = await call(b, "/api/auth/subscription/upgrade", early, UPGRADE);
      check(unset.status === 503 && ((await unset.json()) as Obj).code === "STRIPE_NOT_CONFIGURED", `upgrade with placeholder keys -> ${unset.status}, expected 503 STRIPE_NOT_CONFIGURED`);
      // The placeholder webhook secret is public: an event signed with it is refused.
      const forged = await webhook(b, { type: "customer.subscription.updated", data: { object: { id: "sub_forged", customer: "cus_forged", status: "active", items: { data: [] } } } }, undefined, "whsec_placeholder");
      check(forged.status === 400 && ((await forged.json()) as Obj).code === "STRIPE_WEBHOOK_NOT_CONFIGURED", `a webhook signed with whsec_placeholder -> ${forged.status}, expected 400`);
      console.log("gate: payments with placeholder keys: the app serves, /billing and the upgrade route say Stripe isn't set up yet (503), a webhook signed with whsec_placeholder is 400");

      const STRIPE = { STRIPE_SECRET_KEY: "sk_test_gate", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_URL: `http://127.0.0.1:${server.port}` };
      // The seed script: refuses live keys before calling Stripe, creates the declared price once, and a rerun creates nothing.
      // Async: the fake Stripe runs in this process, so a sync spawn would block it from answering.
      const seed = async (env: Record<string, string>) => {
        const p = spawnTracked([process.execPath, "run", "stripe:seed"], { cwd: app, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
        return { stdout, stderr, exitCode };
      };
      const before = fake.calls.length;
      for (const k of ["sk_live_gate", "rk_live_gate"]) {
        const r = await seed({ ...STRIPE, STRIPE_SECRET_KEY: k });
        check(r.exitCode === 1 && r.stderr.includes("refuses live keys"), `stripe:seed with a ${k.slice(0, 7)} key exited ${r.exitCode}`);
      }
      check(fake.calls.length === before, "stripe:seed called Stripe with a live key");
      const first = await seed(STRIPE), again = await seed(STRIPE);
      check(first.exitCode === 0 && first.stdout.includes("created: pro_monthly"), `stripe:seed -> ${first.exitCode}: ${first.stdout}${first.stderr}`);
      check(again.exitCode === 0 && again.stdout.includes("exists: pro_monthly") && fake.prices.size === 1, `stripe:seed rerun -> ${again.exitCode}, ${fake.prices.size} prices`);
      console.log("gate: stripe:seed refuses sk_live_ and rk_live_ keys before any call, creates the declared price by lookup key, and a rerun creates nothing");

      const bossMail = `payer-boss-${Date.now()}@example.com`; // with --admin: the admin who removes a subscribed user below
      let boss = ""; // the admin's session cookie, set once in the --admin block below
      b = await restart({ ...STRIPE, ...(config.admin && { ADMIN_EMAILS: bossMail }) });
      const [aMail, bMail] = [`payer-a-${Date.now()}@example.com`, `payer-b-${Date.now()}@example.com`];
      const a = await user(b, aMail), other = await user(b, bMail);
      const aId = idOf(aMail), bId = idOf(bMail);
      // Signed out and cross-site requests are refused, and no Stripe call is made for them.
      check((await page(b)).includes("Sign in to manage billing"), "/billing signed out lacks the sign-in line");
      const calls0 = fake.calls.length;
      for (const path of ["/api/auth/subscription/upgrade", "/api/auth/subscription/billing-portal"]) {
        const out = (await call(b, path, "", UPGRADE)).status, cross = (await call(b, path, a, { ...UPGRADE, returnUrl: "/billing" }, "https://evil.test")).status;
        check(out === 401 && cross === 403, `${path}: signed out -> ${out} (expected 401), cross-site -> ${cross} (expected 403)`);
      }
      check(fake.calls.length === calls0, `refused requests reached Stripe: ${fake.calls.slice(calls0).join(", ")}`);
      const none = await page(b, a);
      check(none.includes("You're not on a plan.") && none.includes("Subscribe to Pro") && !none.includes("Manage billing"), "/billing for a user with no plan lacks the no-plan copy or the Subscribe button");
      check((await call(b, "/api/example-plan", a)).status === 403 && (await call(b, "/api/example-plan")).status === 401, "requirePlan: no plan should be 403, signed out 401");
      console.log("gate: payments: /billing signed out and with no plan; checkout and portal refuse signed-out (401) and cross-site (403) requests with no Stripe call; requirePlan 401/403");

      // Checkout: the plugin makes the customer (metadata.userId) and an incomplete row, then a Checkout session for the declared price.
      const up = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
      const upBody = (await up.json()) as Obj;
      check(up.ok && upBody.url === "https://checkout.stripe.test/pay", `upgrade -> ${up.status} ${JSON.stringify(upBody)}`);
      const cus = [...fake.customers.values()].find((c) => c.metadata.userId === aId);
      if (!cus) throw new Error("payments: upgrade made no Stripe customer with metadata.userId");
      const cs = [...fake.sessions.values()].at(-1)!;
      check(db((d) => (d.query("SELECT stripeCustomerId AS c FROM user WHERE id = ?").get(aId) as Obj).c) === cus.id, "the user's stripeCustomerId is not the customer Stripe made");
      check(cs.mode === "subscription" && cs.customer === cus.id && cs.line_items["0"].price === [...fake.prices.keys()][0] && cs.client_reference_id === aId, `checkout session: ${JSON.stringify(cs)}`);
      const [incomplete] = subRows(aId);
      check(incomplete?.status === "incomplete" && cs.metadata.subscriptionId === incomplete.id, `rows after upgrade: ${JSON.stringify(subRows(aId))}`);
      // Bad signatures change nothing.
      const subA = stripeSub({ id: "sub_gateA", customer: cus.id, status: "active", metadata: { subscriptionId: incomplete.id, userId: aId, referenceId: aId } });
      const snapshot = allSubs();
      for (const [what, sig] of [["unsigned", ""], ["wrongly signed", await sign("{}", SECRET)], ["signed with another secret", undefined]] as [string, string | undefined][]) {
        const ev = { type: "customer.subscription.updated", data: subObj({ ...subA, status: "past_due" }) };
        const payload = JSON.stringify(ev);
        const r = await fetch(`${b}/api/auth/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig !== "" && { "stripe-signature": sig ?? (await sign(payload, "whsec_not_the_secret")) }) }, body: payload });
        check(r.status === 400, `${what} webhook -> ${r.status}, expected 400`);
      }
      check(allSubs() === snapshot, "a refused webhook changed the subscription table");
      console.log("gate: payments: upgrade makes the customer and an incomplete row and opens Checkout for the declared price; unsigned, wrongly signed and foreign-secret webhooks get 400 and change nothing");
      // Checkout completes: the success redirect syncs from Stripe at once; then the webhooks arrive (created is skipped for the checkout's own row).
      Object.assign(cs, { subscription: subA.id, payment_status: "paid", status: "complete" });
      const back = await call(b, `/api/auth/subscription/success?callbackURL=%2Fbilling&checkoutSessionId=${cs.id}`, a);
      check(back.status === 302 && new URL(back.headers.get("location") ?? "", b).pathname === "/billing", `success redirect -> ${back.status} ${back.headers.get("location")}`);
      check(subRows(aId)[0].status === "active", "the success redirect did not sync the plan");
      for (const ev of [{ type: "customer.subscription.created", data: subObj(subA) }, { type: "checkout.session.completed", data: subObj(cs) }]) check((await webhook(b, ev)).status === 200, `${ev.type} -> not 200`);
      check(subRows(aId).length === 1 && subRows(aId)[0].stripeSubscriptionId === subA.id, `rows after checkout: ${JSON.stringify(subRows(aId))}`);
      const active = await page(b, a);
      check(active.includes("Pro. Renews on") && active.includes("Manage billing") && !active.includes("Subscribe to Pro"), "/billing after checkout lacks the active plan");
      check((await call(b, "/api/example-plan", a)).status === 200, "requirePlan refused an active plan");
      // Another user sees and manages only their own billing.
      check((await page(b, other)).includes("You're not on a plan."), "another user's /billing shows A's plan");
      const theirs = await call(b, `/api/auth/subscription/list?referenceId=${aId}`, other);
      check(theirs.status === 400 && (await call(b, "/api/auth/subscription/list", other).then((r) => r.json())).length === 0, `another user listing A's subscription -> ${theirs.status}`);
      check((await call(b, "/api/auth/subscription/billing-portal", other, { returnUrl: "/billing", referenceId: aId })).status === 400, "another user opened A's portal");
      check((await call(b, "/api/auth/subscription/billing-portal", other, { returnUrl: "/billing" })).status === 404, "a user with no customer got a portal");
      const portal = await call(b, "/api/auth/subscription/billing-portal", a, { returnUrl: "/billing" });
      check(portal.ok && ((await portal.json()) as Obj).url === "https://billing.stripe.test/session", `portal -> ${portal.status}`);
      console.log("gate: payments: the success redirect shows the plan before any webhook; created and checkout.session.completed answer 200 and keep one row; requirePlan 200; another user can't read or manage it; the portal opens");

      // #85, with --admin: plan-gated feature switches and the admin Billing section. `a` is active on pro here; `other` has no plan and no Stripe customer.
      if (config.admin) {
        boss = await user(b, bossMail);
        onUser(bossMail, "UPDATE user SET emailVerified = 1 WHERE id = ?");
        const F = "example-feature";
        const gated = (cookie: string) => call(b, `/api/${F}`, cookie).then((r) => r.status);
        const setGlobal = (state: string) => call(b, `/api/admin/features/${F}`, boss, { state }).then((r) => r.status);
        const setUser = (uid: string, state: string) => call(b, `/api/admin/users/${uid}/features/${F}`, boss, { state }).then((r) => r.status);
        check((await setGlobal("off")) === 200, "could not turn the feature off for everyone");
        check((await gated(other)) === 403, "a plan-only feature is on for a user with no plan");
        check((await gated(a)) === 200, "a plan-only feature is off for a user on the plan");
        check((await setGlobal("kill")) === 200 && (await gated(a)) === 403, "the kill switch did not beat the plan");
        check((await setGlobal("off")) === 200 && (await gated(a)) === 200, "the plan feature did not come back after the kill switch");
        check((await setUser(bId, "on")) === 200 && (await gated(other)) === 200, "a comped user (override on) with no plan was refused");
        check((await setUser(aId, "off")) === 200 && (await gated(a)) === 403, "an override off did not beat the plan");
        check((await setUser(bId, "default")) === 200 && (await setUser(aId, "default")) === 200 && (await gated(other)) === 403 && (await gated(a)) === 200, "resetting the overrides did not restore the plan result");
        const text = (path: string) => call(b, path, boss).then((r) => r.text());
        check((await text("/admin/features")).includes("Also on for users on the pro plan"), "/admin/features does not say the feature is on for the pro plan");
        check((await text(`/admin/users/${aId}`)).includes("Effective: On: included in the user"), "user detail does not say On: included in the user's plan");
        const billing = await text(`/admin/users/${aId}`);
        check(billing.includes("Billing") && billing.includes("Active, renews on") && billing.includes(`https://dashboard.stripe.com/test/customers/${cus.id}`), "the admin Billing section lacks the plan, status or the test-mode dashboard link");
        check(!billing.includes("sk_test_gate"), "the admin page contains the Stripe key");
        const empty = await text(`/admin/users/${bId}`);
        check(empty.includes("No subscription.") && empty.includes("No Stripe customer yet") && !empty.includes("dashboard.stripe.com"), "the admin Billing section has no empty state for a user with no subscription");
        console.log("gate: payments + admin: a plan-only feature is off without the plan, on with it, off under the kill switch, on for a comped user with no plan, off for an override off; Features says it is on for users on the pro plan; the user page shows Billing (plan, status, test-mode Stripe link) and a clear empty state");
      }

      // Stripe's state changes (the fake's subscription is the live one the app reads back), then the event for it arrives.
      const emit = (type: string, change: Obj) => webhook(b, { type, data: subObj({ ...Object.assign(subA, change) }) });
      // past_due: shown with the fix-your-card copy, still counts for requirePlan, and blocks a second Checkout.
      check((await emit("customer.subscription.updated", { status: "past_due" })).status === 200, "updated past_due -> not 200");
      const due = await page(b, a);
      check(due.includes("Your last payment failed") && due.includes("Manage billing") && !due.includes("Subscribe to Pro"), "/billing for past_due lacks the failure copy or still offers Subscribe");
      check((await call(b, "/api/example-plan", a)).status === 200, "requirePlan refused a past_due plan");
      const sessions = fake.sessions.size;
      const second = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
      check(second.status === 400 && ((await second.json()) as Obj).code === "SUBSCRIPTION_NEEDS_CARD" && fake.sessions.size === sessions, `a past_due user's second upgrade -> ${second.status}`);
      // unpaid: inactive for requirePlan, and still no second Checkout.
      check((await emit("customer.subscription.updated", { status: "unpaid" })).status === 200, "updated unpaid -> not 200");
      check((await page(b, a)).includes("is paused because payments failed") && (await call(b, "/api/example-plan", a)).status === 403, "unpaid lacks the paused copy or passed requirePlan");
      if (config.admin) check((await call(b, "/api/example-feature", a)).status === 403, "an unpaid subscription still grants a plan feature");
      const third = await call(b, "/api/auth/subscription/upgrade", a, UPGRADE);
      check(third.status === 400 && ((await third.json()) as Obj).code === "SUBSCRIPTION_NEEDS_CARD" && fake.sessions.size === sessions, `an unpaid user's second upgrade -> ${third.status}`);
      // A lost write: the database refuses the update (the plugin's and the sync's), so the event answers an error and Stripe retries; the retry lands.
      db((d) => d.run("CREATE TRIGGER gate_fail BEFORE UPDATE ON subscription WHEN NEW.status = 'active' BEGIN SELECT RAISE(ABORT, 'gate'); END"));
      const lost = await emit("customer.subscription.updated", { status: "active", cancel_at_period_end: true });
      db((d) => d.run("DROP TRIGGER gate_fail"));
      check(lost.status >= 400 && subRows(aId)[0].status === "unpaid", `an update whose write failed -> ${lost.status}, row ${subRows(aId)[0].status}`);
      check((await emit("customer.subscription.updated", {})).status === 200, "the retried update -> not 200");
      check((await page(b, a)).includes("Pro. Cancelling, ends on"), "/billing for a cancelling plan lacks the end date");
      console.log("gate: payments: past_due shows the fix-your-card copy, still passes requirePlan and refuses a second Checkout; unpaid fails requirePlan and refuses one too; a failed write answers an error and the retry lands; cancelling shows its end date");

      // No user holds the customer (a dashboard subscription, or a deleted user whose rows are gone): 200 and nothing changes.
      const ghostMail = `payer-ghost-${Date.now()}@example.com`;
      const ghost = await user(b, ghostMail);
      check((await call(b, "/api/auth/subscription/upgrade", ghost, UPGRADE)).ok, "the ghost user's upgrade failed");
      const ghostId = idOf(ghostMail), ghostCus = [...fake.customers.values()].find((c) => c.metadata.userId === ghostId)!.id;
      db((d) => { d.run("DELETE FROM subscription WHERE referenceId = ?", [ghostId]); d.run("DELETE FROM session WHERE userId = ?", [ghostId]); d.run("DELETE FROM account WHERE userId = ?", [ghostId]); d.run("DELETE FROM user WHERE id = ?", [ghostId]); });
      const quiet = allSubs();
      for (const [customer, why] of [["cus_unknown_gate", "an unknown customer"], [ghostCus, "a deleted user"]])
        for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
          const r = await webhook(b, { type, data: subObj(stripeSub({ id: `sub_${customer}`, customer, status: "past_due" })) });
          check(r.status === 200, `${type} for ${why} -> ${r.status}, expected 200`);
        }
      check(allSubs() === quiet, "an event for a customer no user holds changed the subscription table");
      console.log("gate: payments: subscription events for an unknown customer and for a deleted user's customer answer 200 and change nothing");

      const older = { ...subA, status: "active", cancel_at_period_end: false }; // an update Stripe sent before the deletion
      check((await emit("customer.subscription.deleted", { status: "canceled" })).status === 200, "deleted -> not 200");
      const ended = await page(b, a);
      check(subRows(aId)[0].status === "canceled" && ended.includes("Your Pro plan has ended.") && ended.includes("Subscribe to Pro"), "/billing after deletion lacks the ended copy or the Subscribe button");
      check((await call(b, "/api/example-plan", a)).status === 403, "requirePlan let a canceled plan through");
      if (config.admin) check((await call(b, "/api/example-feature", a)).status === 403, "a canceled subscription still grants a plan feature");
      // Out of order: that older update, retried after the deletion, must not bring the plan back.
      check((await webhook(b, { type: "customer.subscription.updated", data: subObj(older) })).status === 200, "a late older update -> not 200");
      check(subRows(aId)[0].status === "canceled" && (await call(b, "/api/example-plan", a)).status === 403, `a late older update revived the plan: row ${subRows(aId)[0].status}`);
      console.log("gate: payments: a deleted subscription shows as ended with Subscribe back, requirePlan refuses it, and an older update retried afterwards leaves it canceled");

      // #84: deleting a user cancels their subscriptions in Stripe first, on both paths (self-service, admin removal), ahead of the storage purge.
      // Each doomed user has a customer, the checkout's row, and one subscription per status in Stripe that the app has no row for (no webhook yet).
      const removals: [string, "all" | "cancel", (d: { cookie: string; uid: string }) => Promise<Response>][] = [];
      if (config.accountDeletion) removals.push(["self-service deletion", "all", (d) => call(b, "/api/auth/delete-user", d.cookie, { password: gatePw })]);
      if (config.admin) {
        removals.push(["admin removal", "cancel", (d) => call(b, "/api/auth/admin/remove-user", boss, { userId: d.uid })]);
      }
      for (const [how, outage, remove] of removals) {
        const mail = `payer-doomed-${removals.length}-${how.length}-${Date.now()}@example.com`;
        const cookie = await user(b, mail), uid = idOf(mail), d = { cookie, uid };
        check((await call(b, "/api/auth/subscription/upgrade", cookie, UPGRADE)).ok, `${how}: the doomed user's upgrade failed`);
        const customer = [...fake.customers.values()].find((c) => c.metadata.userId === uid)!.id;
        const subs = ["past_due", "active", "canceled", "incomplete_expired"].map((status) => stripeSub({ id: `sub_${uid}_${status}`, customer, status }));
        const statuses = () => subs.map((x) => x.status).join(",");
        // The upgrade left a Checkout session open: paid after the deletion it would start a subscription nobody owns.
        const checkout = [...fake.sessions.values()].find((x) => x.customer === customer)!;
        check(checkout.status === "open", `${how}: the doomed user's Checkout session is ${checkout.status}, expected open`);
        const file = `users/${uid}/keep.txt`;
        if (config.storage) {
          const put = await fetch(`${b}/api/files/keep.txt`, { method: "PUT", body: "keep", headers: { cookie, "content-type": "text/plain" } });
          check(put.status === 201 && r2Keys().includes(file), `${how}: the doomed user's upload -> ${put.status}`);
        }
        // Stripe is down: the deletion stops with the code and message the pages show; the user, their rows, their files and their subscriptions are
        // untouched. Checkout sessions are expired first, so when only the cancel fails the open session is already expired (a retry is safe).
        fake.down = outage;
        const refused = await remove(d), why = (await refused.json()) as Obj;
        fake.down = "";
        check(refused.status === 500 && why.code === "BILLING_CANCEL_FAILED" && why.message === "Couldn't cancel the subscription in Stripe, so the account was not deleted. Try again.", `${how} with Stripe down (${outage}) -> ${refused.status} ${JSON.stringify(why)}`);
        check(userRow(mail) && subRows(uid).length === 1 && statuses() === "past_due,active,canceled,incomplete_expired" && checkout.status === (outage === "all" ? "open" : "expired"), `${how} with Stripe down deleted the user or their rows, or cancelled something`);
        check(!config.storage || r2Keys().includes(file), `${how} with Stripe down purged the user's files`);
        // Stripe is back: every subscription that hadn't ended is cancelled (past_due included, the ended ones left alone), then the user, rows and files go.
        const mark = fake.calls.length;
        const gone = await remove(d);
        check(gone.status === 200, `${how} -> ${gone.status}`);
        const cancelled = fake.calls.slice(mark).filter((c) => c.startsWith("DELETE "));
        check(statuses() === "canceled,canceled,canceled,incomplete_expired" && cancelled.join() === [subs[0]!, subs[1]!].map((x) => `DELETE /v1/subscriptions/${x.id}`).join(), `${how}: Stripe has ${statuses()} after ${cancelled.join(", ") || "no cancel"}`);
        check(checkout.status === "expired", `${how} left the user's Checkout session ${checkout.status}`);
        check(!userRow(mail) && subRows(uid).length === 0, `${how} left the user or their subscription rows`);
        check(!config.storage || !r2Keys().some((k) => k.startsWith(`users/${uid}/`)), `${how} left the user's files`);
        // Stripe's event for the cancellation arrives after the user is gone: 200, so Stripe doesn't retry. It is on a declared price, so the
        // sync does not skip it as someone else's: it gets as far as finding that no user holds the customer.
        check(subs[0]!.items.data[0]!.price.lookup_key === "pro_monthly" && !db((d) => d.query("SELECT 1 FROM user WHERE stripeCustomerId = ?").get(customer)), `${how}: the late event is not on a declared price, or a user still holds ${customer}`);
        const late = await webhook(b, { type: "customer.subscription.deleted", data: subObj(subs[0]!) });
        check(late.status === 200 && subRows(uid).length === 0, `${how}: a late customer.subscription.deleted -> ${late.status}`);
        console.log(`gate: payments: ${how} stops with 500 BILLING_CANCEL_FAILED while Stripe is down (user, rows${config.storage ? ", files" : ""} and Stripe untouched); then cancels the past_due and active subscriptions and expires the open Checkout session in Stripe first, deletes the user${config.storage ? ", files" : ""} and subscription rows, and a late customer.subscription.deleted answers 200`);
      }

      // Static checks: one better-auth, the webhook's rate-limit exemption, the plugin's tables in the migration.
      const copies: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const sub = join(dir, e.name);
          if (e.name === "better-auth" && existsSync(join(sub, "package.json"))) copies.push(sub);
          if (e.name.startsWith("@")) walk(sub);
          else if (existsSync(join(sub, "node_modules"))) walk(join(sub, "node_modules"));
        }
      };
      walk(join(app, "node_modules"));
      check(copies.length === 1, `expected one better-auth, found ${copies.join(", ") || "none"}`);
      check(/customRules:\s*\{\s*"\/stripe\/webhook":\s*false/.test(readFileSync(join(app, "auth.ts"), "utf8")), "auth.ts does not exempt /stripe/webhook from rate limiting");
      const sql = readdirSync(join(app, "db/migrations")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(app, "db/migrations", f), "utf8")).join("\n");
      check(/CREATE TABLE\s+[`"']?subscription\b/.test(sql) && /stripeCustomerId/.test(sql), "no migration creates the subscription table and user.stripeCustomerId");
      console.log("gate: payments: exactly one better-auth installed; the webhook path is exempt from rate limiting; the migration has the plugin's tables");
    } finally {
      server.stop(true);
      writeFileSync(envFile, original);
    }
  };
  if (config.payments) await paymentsGate();
  if (config.secrets) {
    // A fake `infisical` first on PATH records its argv (FAKE_LOG) and is driven by env: FAKE_EXIT, FAKE_EXPORT (file contents), FAKE_STDERR.
    // Like the real CLI, it rejects a --file holding an empty value.
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "infisical"), [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_LOG"',
      '[ -n "$INFISICAL_ZS_PROBE" ] && echo leaked >> "$FAKE_LOG.probe"', // .env must never reach this child
      'for a in "$@"; do [ "$prev" = --file ] && file="$a"; prev="$a"; case "$a" in --output-file=*) out="${a#--output-file=}";; esac; done',
      '[ -n "$out" ] && printf \'%s\' "$FAKE_EXPORT" > "$out"',
      `[ -n "$file" ] && grep -Eq "^[^=]*=(''|\\"\\"|)$" "$file" && exit 1`,
      'echo "$FAKE_STDERR" >&2',
      'echo "$FAKE_STDERR"',
      'exit "${FAKE_EXIT:-0}"',
    ].join("\n") + "\n", { mode: 0o755 });
    const log = join(root, "fake-argv.log");
    const runScript = (fake: Record<string, string>, script = ["run", "secrets:pull"]) => {
      const r = Bun.spawnSync([process.execPath, ...script], {
        cwd: app, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...fake },
      });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    const envFile = join(app, ".env"), tmp = join(app, ".env.pull-tmp"), yaml = join(app, ".infisical.yaml");
    const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`secrets:pull ${what}`); };
    const checkPush = (ok: boolean, what: string) => { if (!ok) throw new Error(`secrets:push ${what}`); };

    for (const f of [".env", ".env.pull-tmp"])
      check(Bun.spawnSync(["git", "check-ignore", "-q", f], { cwd: app }).exitCode === 0, `${f} is not gitignored`);

    const before = readFileSync(envFile);
    // No link file: refuse with the link guidance.
    let r = runScript({ FAKE_EXPORT: "X=1\n" });
    check(r.code === 1 && r.out.includes("secret-sync") && r.out.includes("infisical init --project-id"), `without a link file exited ${r.code} without the guidance: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp) && !existsSync(log), "without a link file touched .env, left a temp file or ran infisical");

    writeFileSync(yaml, "workspaceId: gate\n");
    // Export lacks a key the current .env has.
    r = runScript({ FAKE_EXPORT: "BETTER_AUTH_SECRET=other\n" });
    check(r.code === 1 && r.out.includes("BETTER_AUTH_URL") && !r.out.includes("other"), `with a missing key exited ${r.code}, output: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp), "with a missing key changed .env or left a temp file");
    // Infisical fails with a secret-looking string on both streams: never printed.
    r = runScript({ FAKE_EXPORT: "BETTER_AUTH_SECRET=other\n", FAKE_EXIT: "3", FAKE_STDERR: "LEAKED-sk_live_abc123" });
    check(r.code === 1 && r.out.includes("infisical exited 3") && !r.out.includes("LEAKED") && !r.out.includes("other"), `on a failing infisical exited ${r.code}, output: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp), "on a failing infisical changed .env or left a temp file");
    // Success: contents replaced verbatim, mode 0600, the expected argv; the legacy link file works too.
    // Built from the scaffold's own .env so every key it has (Turnstile, ...) is present.
    const exported = readFileSync(envFile, "utf8").replace(/^BETTER_AUTH_SECRET=.*$/m, "BETTER_AUTH_SECRET=pulled") + "EXTRA=pre post\n";
    const exportedKeys = exported.trim().split("\n").length;
    rmSync(yaml);
    writeFileSync(join(app, ".infisical.json"), "{}\n");
    r = runScript({ FAKE_EXPORT: exported });
    check(r.code === 0, `ok run exited ${r.code}: ${r.out}`);
    check(readFileSync(envFile, "utf8") === exported, ".env is not the export verbatim");
    check((statSync(envFile).mode & 0o777) === 0o600 && !existsSync(tmp), "left .env not 0600 or left a temp file");
    check(readFileSync(log, "utf8").includes("export --env=dev --format=dotenv --expand=false --silent"), `ran infisical with ${readFileSync(log, "utf8")}`);
    // The script itself rejects an unknown subcommand.
    r = runScript({}, ["scripts/secrets.ts", "bogus"]);
    check(r.code === 1 && r.out.includes("Usage"), `unknown subcommand exited ${r.code}`);
    // secrets:push. .env is now the pulled export; the fake prints a value on both streams.
    const pushed = readFileSync(envFile);
    rmSync(log, { force: true });
    r = runScript({ FAKE_STDERR: "LEAKED-sk_live_abc123" }, ["run", "secrets:push"]);
    checkPush(r.code === 0 && r.out.includes(`Pushed ${exportedKeys} keys`) && !r.out.includes("LEAKED") && !r.out.includes("pulled"), `push ok exited ${r.code}, output: ${r.out}`);
    checkPush(readFileSync(log, "utf8").trim() === "secrets set --file .env --env=dev --silent", `push ran infisical with ${readFileSync(log, "utf8")}`);
    // A .env key must not reach the infisical child's environment (an INFISICAL_* key would redirect the CLI): --no-env-file.
    writeFileSync(envFile, Buffer.concat([pushed, Buffer.from("INFISICAL_ZS_PROBE='x'\n")]));
    for (const cmd of ["secrets:push", "secrets:pull"]) runScript({ FAKE_EXPORT: pushed.toString() + "INFISICAL_ZS_PROBE='x'\n" }, ["run", cmd]);
    checkPush(!existsSync(log + ".probe"), "passed a .env key into the infisical child's environment");
    writeFileSync(envFile, pushed);
    rmSync(log);
    r = runScript({ FAKE_STDERR: "LEAKED-sk_live_abc123", FAKE_EXIT: "4" }, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes("infisical exited 4") && r.out.includes("may already have been set") && r.out.includes("Rerun by hand")
      && !/Pushed/.test(r.out) && !r.out.includes("LEAKED") && !r.out.includes("pulled"), `failing push exited ${r.code}, output: ${r.out}`);
    // Bad names: refused before infisical runs; names listed, values not.
    rmSync(log);
    writeFileSync(envFile, "lower_case=VALUE-ONE\nVITE_API_TOKEN=VALUE-TWO\nVOID_X=VALUE-THREE\nGOOD_KEY=VALUE-FOUR\n");
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && ["lower_case", "VITE_API_TOKEN", "VOID_X"].every((n) => r.out.includes(n)) && !r.out.includes("GOOD_KEY") && !r.out.includes("VALUE-"), `bad names exited ${r.code}, output: ${r.out}`);
    checkPush(!existsSync(log), "push with bad names still ran infisical");
    // Empty values: Infisical's --file rejects them, so push refuses them by line number before infisical runs.
    writeFileSync(envFile, Buffer.concat([pushed, Buffer.from("EMPTY_KEY=''\n")]));
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes(`line ${pushed.toString().split("\n").length}: Infisical rejects empty values`) && !existsSync(log), `push with an empty value exited ${r.code}, output: ${r.out}`);
    writeFileSync(envFile, pushed);
    // Lines outside the strict format (spec story 11): push refuses before infisical runs, pull refuses the same in the export (and in
    // the local .env), leaving .env as it was. Both report the line number only, never text from the line (it may be part of a value).
    writeFileSync(join(app, ".infisical.json"), "{}\n");
    const at = pushed.toString().split("\n").length; // the 1-based number of a line appended to `pushed`
    for (const bad of [
      'PRIVATE_PEM="-----BEGIN KEY-----\nhunter2=ghi\n-----END KEY-----"\n', "export C=hunter2\n", "TOKEN_KEY=`hunter2`\n",
      'PRIVATE_KEY="hunter2\\nb"\n', "A_KEY='hunter2\\'b'\n", "DB_PASSWORD='pa$hunter2'\n", 'WIN_DIR="C:\\hunter2\\"\nVITE_ADMIN_TOKEN="tok"\n',
    ]) {
      rmSync(log, { force: true });
      writeFileSync(envFile, Buffer.concat([pushed, Buffer.from(bad)]));
      r = runScript({}, ["run", "secrets:push"]);
      checkPush(r.code === 1 && r.out.includes(`line ${at}`) && !r.out.includes("hunter2") && !existsSync(log), `push with ${JSON.stringify(bad)} exited ${r.code}, output: ${r.out}`);
      r = runScript({ FAKE_EXPORT: pushed.toString() });
      check(r.code === 1 && r.out.includes(`.env line ${at}`) && !r.out.includes("hunter2") && readFileSync(envFile).equals(Buffer.concat([pushed, Buffer.from(bad)])) && !existsSync(tmp), `pull with ${JSON.stringify(bad)} in .env exited ${r.code}, output: ${r.out}`);
      writeFileSync(envFile, pushed);
      r = runScript({ FAKE_EXPORT: pushed.toString() + bad });
      check(r.code === 1 && r.out.includes(`export line ${at}`) && !r.out.includes("hunter2") && readFileSync(envFile).equals(pushed) && !existsSync(tmp), `pull with ${JSON.stringify(bad)} in the export exited ${r.code}, output: ${r.out}`);
    }
    // The generated tsconfig covers scripts/: a type error there fails tsc.
    const script = join(app, "scripts/secrets.ts"), scriptSrc = readFileSync(script);
    writeFileSync(script, Buffer.concat([scriptSrc, Buffer.from('\nconst n: number = "x";\n')]));
    const tsc = Bun.spawnSync([join(app, "node_modules/.bin/tsc"), "--noEmit"], { cwd: app });
    writeFileSync(script, scriptSrc);
    checkPush(tsc.exitCode !== 0 && /scripts\/secrets\.ts/.test(tsc.stdout.toString()), `tsc did not report a type error in scripts/secrets.ts (exit ${tsc.exitCode}): ${tsc.stdout.toString().slice(0, 300)}`);
    // No link file.
    rmSync(join(app, ".infisical.json"));
    rmSync(log, { force: true });
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes("secret-sync") && r.out.includes("infisical init --project-id") && !existsSync(log), `push without a link file exited ${r.code}, output: ${r.out}`);
    console.log("gate: secrets:push sends the exact argv and prints only the key count; refuses bad names, lines outside the format, no link and an infisical failure without leaking a value");
    console.log("gate: secrets:pull refuses without a link / on a missing key / on a line outside the format / on an infisical failure (.env untouched, nothing leaked); ok pull is verbatim 0600");
  }
} catch (e) {
  console.error(`gate failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await killChildren(); // the dev server and anything still running
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`gate: could not remove ${root}: ${(e as Error).message}`); }
}
