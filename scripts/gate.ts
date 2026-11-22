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
  const startDev = async () => {
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
      const d = new Database(f, { readonly: true });
      try {
        return !!d.query("SELECT 1 FROM sqlite_master WHERE name = 'user'").get() && !!d.query("SELECT 1 FROM user WHERE lower(email) = ?").get(address.toLowerCase());
      } finally { d.close(); }
    });
  // Runs `sql` with the user's id against the auth database (the one with a user row for the address).
  const onUser = (address: string, sql: string) => {
    for (const f of sqliteFiles(join(app, ".void"))) {
      const d = new Database(f);
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
