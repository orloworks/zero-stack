// Scaffold into a temp dir, then vp check/build/test, verify, db:reset, GET / against vp dev.
// Optional args choose the permutation: bun scripts/gate.ts [--framework vue] [--<feature flag from src/flags.ts>...] [--name x]
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv as featureArgv, FEATURE_LIST, validateFlags } from "../src/flags";
import { killChildren, onTerminate, spawnTracked } from "../src/children";
import { preflight, run, scaffold } from "../src/pipeline";
import { TRUSTED_DEPENDENCIES } from "../src/versions";

const root = mkdtempSync(join(tmpdir(), "zs-gate-"));
const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const hasSeq = (seq: string[]) => argv.some((_, i) => seq.every((t, j) => argv[i + j] === t));
const name = arg("--name") ?? "gate-app";
const app = join(root, name);
const vp = join(app, "node_modules/.bin/vp");
let dev: ReturnType<typeof Bun.spawn> | undefined;

// SIGINT/SIGTERM: every child (steps, dev server) is killed and awaited, then the temp dir goes; exit 130/143.
onTerminate(() => rmSync(root, { recursive: true, force: true }), 10_000);

// Request cookie header from a response's Set-Cookie headers.
const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const step = (args: string[]) => run([vp, ...args], app);
const sqliteFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sqliteFiles(join(dir, e.name)) : e.name.endsWith(".sqlite") ? [join(dir, e.name)] : []);

try {
  preflight();
  const input = {
    name,
    framework: arg("--framework"),
    ...Object.fromEntries(FEATURE_LIST.map((f) => [f.key, hasSeq(featureArgv(f)) || undefined])),
  };
  const { config } = validateFlags(input);
  await scaffold(config, app);
  const pkgJson = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
  if (JSON.stringify(pkgJson.trustedDependencies) !== JSON.stringify(TRUSTED_DEPENDENCIES))
    throw new Error(`package.json trustedDependencies is ${JSON.stringify(pkgJson.trustedDependencies)}`);
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
  const plant = new Database(dbFile);
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
  const after = new Database(dbFile, { readonly: true });
  const tables = (after.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_void_migrations'").all() as { name: string }[]).map((x) => x.name);
  if (!tables.includes(t)) throw new Error(`db:reset dropped the ${t} table`);
  const rows = tables.filter((t) => (after.query(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c > 0);
  after.close();
  if (rows.length) throw new Error(`db:reset left rows in: ${rows.join(", ")}`);
  console.log("gate: db:reset empties the app database");

  const agents = readFileSync(join(app, "AGENTS.md"), "utf8");
  for (const b of ["routing", "verify"])
    if (!agents.includes(`<!-- zero-stack:${b} -->`)) throw new Error(`AGENTS.md lost the zero-stack:${b} block after verify`);

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
  const port = freePort();
  dev = spawnTracked([vp, "dev", "--port", String(port), "--strictPort"], {
    cwd: app, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, VOID_INSPECTOR_PORT: String(freePort()) },
  });
  let status = 0;
  for (let i = 0; i < 120 && status !== 200; i++) {
    await Bun.sleep(500);
    if (dev.exitCode !== null) throw new Error("vp dev exited early");
    status = await fetch(`http://localhost:${port}/`).then((r) => r.status, () => 0);
  }
  if (status !== 200) throw new Error(`GET / returned ${status}`);
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
    const inn = await post("/api/auth/sign-in/email", { email, password });
    const cookie = cookieOf(inn);
    if (!inn.ok || !cookie) throw new Error(`auth sign-in -> ${inn.status}, cookie ${cookie ? "set" : "missing"}`);
    const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie } }).then((r) => r.json() as Promise<any>);
    if (session?.user?.email !== email) throw new Error("auth get-session did not return the signed-in user");
    console.log("gate: auth sign-up -> sign-in -> session ok");
    // --storage: routes are auth-gated and per-user. Keys are read back from the local R2 state (miniflare's _mf_objects) to prove what is stored.
    // Only the sqlite files with an _mf_objects table are R2's; any read error on one of them fails the gate.
    const r2Keys = () => {
      let found = false;
      const keys = sqliteFiles(join(app, ".void")).flatMap((f) => {
        const d = new Database(f, { readonly: true });
        try {
          if (!d.query("SELECT 1 FROM sqlite_master WHERE name = '_mf_objects'").get()) return [];
          found = true;
          return (d.query("SELECT key FROM _mf_objects").all() as { key: string }[]).map((r) => r.key);
        } catch (e) { throw new Error(`cannot read R2 keys from ${f}: ${(e as Error).message}`); } finally { d.close(); }
      });
      if (!found) throw new Error("no local R2 database (_mf_objects) found under .void");
      return keys;
    };
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
      const keys = r2Keys();
      if (keys.join() !== `users/${storageUser}/a.txt`) throw new Error(`R2 holds ${JSON.stringify(keys)}, expected only users/${storageUser}/a.txt`);
      console.log("gate: storage routes 401 without a session; upload/download under users/<id>/; escaping names rejected");
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
        // Dev inbox: list rows carry subject, recipient and a detail link; the detail page shows the text body escaped.
        const token = readFileSync(join(app, ".void/dev-trigger-token"), "utf8").trim();
        const inbox = (path: string) => fetch(`${base}/__void/inbox${path}`, { headers: { "x-void-dev-trigger": token } }).then((r) => r.text());
        const mailLink = async (subject: string) => {
          const row = (await inbox("")).split("<tr>").find((r) => r.includes(`>${subject}</a>`) && r.includes(email));
          const id = row?.match(/href="\/__void\/inbox\/([^/?"]+)\?/)?.[1];
          if (!id) throw new Error(`no "${subject}" mail for ${email} in the dev inbox`);
          const url = (await inbox(`/${id}`)).match(/https?:\/\/[^\s<]+/)?.[0]?.replaceAll("&amp;", "&");
          if (!url) throw new Error(`"${subject}" mail has no link`);
          return new URL(url);
        };
        await mailLink("Verify your email"); // sent on sign-up, never required to sign in
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
    if (!readFileSync(join(app, ".gitignore"), "utf8").split("\n").includes(".env")) throw new Error(".env not gitignored");
    if ((statSync(join(app, ".env")).mode & 0o777) !== 0o600) throw new Error(".env is not mode 0600");
    const env = readFileSync(join(app, ".env"), "utf8");
    if (!/^BETTER_AUTH_SECRET=\S{40,}$/m.test(env) || !env.includes("BETTER_AUTH_URL=http://localhost:5173"))
      throw new Error(".env missing secret or url");
    console.log("gate: auth migration present, .env gitignored");
  }
  if (config.secrets) {
    // A fake `infisical` first on PATH records its argv (FAKE_LOG) and is driven by env: FAKE_EXIT, FAKE_EXPORT (file contents), FAKE_STDERR.
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "infisical"), [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_LOG"',
      'for a in "$@"; do case "$a" in --output-file=*) out="${a#--output-file=}";; esac; done',
      '[ -n "$out" ] && printf \'%s\' "$FAKE_EXPORT" > "$out"',
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
    // Success: contents replaced verbatim (${X} intact), mode 0600, the expected argv; the legacy link file works too.
    const exported = "BETTER_AUTH_SECRET=pulled\nBETTER_AUTH_URL=http://localhost:5173\nEXTRA=pre${X}post\n";
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
    // secrets:push. .env is now the pulled export (3 keys); the fake prints a value on both streams.
    const pushed = readFileSync(envFile);
    rmSync(log, { force: true });
    r = runScript({ FAKE_STDERR: "LEAKED-sk_live_abc123" }, ["run", "secrets:push"]);
    checkPush(r.code === 0 && /Pushed 3 keys/.test(r.out) && !r.out.includes("LEAKED") && !r.out.includes("pulled"), `push ok exited ${r.code}, output: ${r.out}`);
    checkPush(readFileSync(log, "utf8").trim() === "secrets set --file .env --env=dev --silent", `push ran infisical with ${readFileSync(log, "utf8")}`);
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
    writeFileSync(envFile, pushed);
    // A multi-line quoted value (PEM-style body lines with = and lowercase) is never read as key names: push and pull both stay quiet about it.
    const pem = 'GOOD_KEY=1\nPRIVATE_PEM="-----BEGIN KEY-----\nabcDEF=ghi\nlower_body=xyz\n-----END KEY-----"\n';
    writeFileSync(join(app, ".infisical.json"), "{}\n");
    writeFileSync(envFile, pem);
    r = runScript({ FAKE_EXPORT: pem }, ["run", "secrets:push"]);
    checkPush(r.code === 0 && /Pushed 2 keys/.test(r.out) && !r.out.includes("abcDEF") && !r.out.includes("lower_body"), `push with a PEM value exited ${r.code}, output: ${r.out}`);
    r = runScript({ FAKE_EXPORT: pem });
    check(r.code === 0 && !r.out.includes("abcDEF") && !r.out.includes("lower_body"), `pull with a PEM value exited ${r.code}, output: ${r.out}`);
    writeFileSync(envFile, pushed);
    // No link file.
    rmSync(join(app, ".infisical.json"));
    rmSync(log, { force: true });
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes("secret-sync") && r.out.includes("infisical init --project-id") && !existsSync(log), `push without a link file exited ${r.code}, output: ${r.out}`);
    console.log("gate: secrets:push sends the exact argv and prints only the key count; refuses bad names, no link and an infisical failure without leaking a value");
    console.log("gate: secrets:pull refuses without a link / on a missing key / on an infisical failure (.env untouched, nothing leaked); ok pull is verbatim 0600");
  }
} catch (e) {
  console.error(`gate failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await killChildren(); // the dev server and anything still running
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`gate: could not remove ${root}: ${(e as Error).message}`); }
}
