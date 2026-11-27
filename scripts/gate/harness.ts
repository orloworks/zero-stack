// The gate harness: the app under test, and nothing else. It owns the dev server and its current address, one restart with `.env` edits,
// one request function, the dev inbox, the local sqlite files and one way to make a user. It holds no test data: users, links and cookies
// stay in the checks that create them. No top-level side effects, so a test can import it.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killChildren, spawnTracked } from "../../src/children";
import { editEnv } from "./env";
import { firstLink, mailIds } from "./inbox";

// Request cookie header from a response's Set-Cookie headers.
export const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

// The inbox owner picks the password: every mail to an unverified --invite-only user is a set-password link with this subject.
export const SET_PASSWORD_SUBJECT = "Set your password";

// The always-pass test secret accepts Cloudflare's documented dummy token; without the header the captcha plugin must refuse.
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

// The dev server recreates its local D1 file on a restart; opening it in that window fails with "unable to open database file".
// Retry only that error, for up to 3s (seen in ci:full under load); anything else throws at once.
export const openDb = (file: string, opts?: { readonly?: boolean }): Database => {
  for (let i = 0; ; i++) {
    try {
      return new Database(file, opts);
    } catch (e) {
      if (i >= 15 || !String((e as Error).message).includes("unable to open database file")) throw e;
      Bun.sleepSync(200);
    }
  }
};
export const sqliteFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sqliteFiles(join(dir, e.name)) : e.name.endsWith(".sqlite") ? [join(dir, e.name)] : []);
export const hasTable = (d: Database, table: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table);

// Where the request's Origin header comes from: the app's own address, none at all, or a foreign one.
export type Origin = "same" | "none" | { foreign: string };
export type RequestOptions = {
  base?: string; // default: the current address
  method?: string; // default: GET, or POST with a body
  body?: object; // sent as JSON, with its content-type
  cookie?: string; // sent when not empty
  origin?: Origin; // default: same
  captcha?: boolean; // send the dummy Turnstile token
  redirect?: "manual" | "follow"; // default: follow
  headers?: Record<string, string>; // anything else, last word
};

// How a user is made. `inviteLink` and `markVerified` are the two halves of "verified": which one applies depends on whether the app is invite-only.
export type MakeUser = {
  password: string;
  name?: string; // sign-up name (default "Gate")
  inviteLink?: boolean; // --invite-only: finish through the mailed set-password link (default true); false stops after the sign-up, with no session
  markVerified?: boolean; // otherwise: set emailVerified in the database (default true); false leaves the user unverified
  prefix?: string; // put in front of the failure messages of a sign-up with a password
  requireSignIn?: boolean; // otherwise: throw when the sign-in after the sign-up is refused (default: carry on with whatever cookie it gave)
  base?: string;
};

export type GateHarness = ReturnType<typeof createHarness>;

export function createHarness(o: { app: string; vp: string; turnstile: boolean; inviteOnly: boolean }) {
  const { app, vp } = o;
  const envFile = join(app, ".env");
  const voidDir = join(app, ".void");
  let here = ""; // the dev server's current address

  // ---- the dev server ----
  // Each run needs its own vite port and Cloudflare inspector port (default 9229 collides across runs).
  const freePort = () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const p = probe.port;
    probe.stop(true);
    return p;
  };
  const startOnce = async () => {
    const port = freePort();
    const dev = spawnTracked([vp, "dev", "--port", String(port), "--strictPort"], {
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
    here = `http://localhost:${port}`;
    return { port, status, address: here };
  };
  // One retry with fresh ports when vp dev dies at start (another run took a port between freePort() and listen).
  const start = () => startOnce().catch((e: Error) => {
    if (e.message !== "vp dev exited early") throw e;
    console.error("gate: vp dev exited early, retrying once with fresh ports");
    return startOnce();
  });
  // Stop every tracked child, write `.env` as `from` with `edits` applied (see editEnv), start the dev server; returns the new address.
  // `from` is the file as the check first read it, so each restart starts from the same text. Restoring that file afterwards stays file-only: no restart.
  const restart = async (from: string, edits: Record<string, string | null>) => {
    await killChildren();
    writeFileSync(envFile, editEnv(from, edits));
    return (await start()).address;
  };

  // ---- requests ----
  const request = (path: string, opts: RequestOptions = {}) => {
    const base = opts.base ?? here;
    const { body, cookie, origin = "same", captcha, redirect, headers } = opts;
    return fetch(base + path, {
      method: opts.method ?? (body === undefined ? "GET" : "POST"),
      ...(redirect && { redirect }),
      headers: {
        ...(origin !== "none" && { origin: origin === "same" ? base : origin.foreign }),
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(cookie && { cookie }),
        ...(captcha && { "x-captcha-response": DUMMY_TOKEN }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  // A Better Auth call as the pages make it: POST, JSON, same origin, the dummy captcha token when the app has Turnstile.
  const authPost = (path: string, body: object, base?: string, cookie?: string) => request(path, { method: "POST", body, base, cookie, captcha: o.turnstile });

  // ---- the local databases ----
  // Opens every sqlite file under .void in turn and calls fn on it (closed after), returning what each call returned.
  const eachDb = <T>(fn: (d: Database, file: string) => T, opts: { readonly?: boolean } = {}): T[] =>
    sqliteFiles(voidDir).map((f) => {
      const d = openDb(f, opts.readonly ? { readonly: true } : undefined);
      try { return fn(d, f); } finally { d.close(); }
    });
  // fn on the first sqlite file that has `has` (a table name, or a test of the open file); undefined when none does.
  const findDb = <T>(has: string | ((d: Database) => boolean), fn: (d: Database) => T, opts: { readonly?: boolean } = {}): { value: T } | undefined => {
    for (const f of sqliteFiles(voidDir)) {
      const d = openDb(f, opts.readonly ? { readonly: true } : undefined);
      try {
        if (typeof has === "string" ? hasTable(d, has) : has(d)) return { value: fn(d) };
      } finally { d.close(); }
    }
    return undefined;
  };
  // Same, but a missing file is an error (`missing` replaces its message).
  const withDb = <T>(has: string | ((d: Database) => boolean), fn: (d: Database) => T, opts: { readonly?: boolean; missing?: string } = {}): T => {
    const found = findDb(has, fn, opts);
    if (!found) throw new Error(opts.missing ?? `no database with a ${String(has)} table`);
    return found.value;
  };
  const userByEmail = (d: Database, address: string) =>
    hasTable(d, "user") ? (d.query("SELECT id, emailVerified FROM user WHERE lower(email) = ?").get(address.toLowerCase()) as { id: string; emailVerified: number } | null) : null;
  // Whether the auth database has a user row for the address.
  const hasUser = (address: string) => !!findDb((d) => !!userByEmail(d, address), () => true, { readonly: true });
  // Runs `sql` with the user's id against the auth database (the one with a user row for the address); returns that row.
  const onUser = (address: string, sql: string) =>
    withDb((d) => !!userByEmail(d, address), (d) => { const u = userByEmail(d, address)!; d.run(sql, [u.id]); return u; }, { missing: `no user row for ${address}` });
  const idOf = (address: string) => onUser(address, "SELECT ?").id;

  // ---- the dev inbox ----
  // List rows carry subject, recipient and a detail link; the detail page shows the text body escaped. The trigger token is read fresh (a restart may change it).
  const mailUrls = async (subject: string, to: string, base = here) => {
    const token = readFileSync(join(voidDir, "dev-trigger-token"), "utf8").trim();
    const inbox = (path: string) => fetch(`${base}/__void/inbox${path}`, { headers: { "x-void-dev-trigger": token } }).then((r) => r.text());
    const urls: URL[] = [];
    for (const id of mailIds(await inbox(""), subject, to)) {
      const url = firstLink(await inbox(`/${id}`));
      if (url) urls.push(new URL(url));
    }
    return urls;
  };
  const mailUrl = async (subject: string, to: string, base = here) => (await mailUrls(subject, to, base))[0] ?? null;
  // Mail can be sent in the background of the request, so poll until `n` have arrived (or time out and return what is there).
  const waitMails = async (subject: string, to: string, n: number, base = here) => {
    let urls: URL[] = [];
    for (let i = 0; i < 40 && urls.length < n; i++) {
      urls = await mailUrls(subject, to, base);
      if (urls.length < n) await Bun.sleep(250);
    }
    return urls;
  };
  // Follows a mailed link (no redirect, no Origin) and gives the response, or the address it redirects to.
  const follow = (link: URL, base = here) => request(link.pathname + link.search, { base, origin: "none", redirect: "manual" });
  const landing = async (link: URL, base = here) => new URL((await follow(link, base)).headers.get("location") ?? "", base);
  // The token on the /reset-password page a mailed link lands on; `what` names the link in the failure.
  const resetToken = async (link: URL, what: string, base = here) => {
    const landed = await landing(link, base);
    const token = landed.searchParams.get("token");
    if (landed.pathname !== "/reset-password" || !token) throw new Error(`${what} link landed on ${landed}`);
    return token;
  };
  // --invite-only: following a set-password link lands on /reset-password?token=; the password is set through it.
  const setPassword = async (link: URL, newPassword: string, base = here) =>
    authPost("/api/auth/reset-password", { newPassword, token: await resetToken(link, "set-password", base) }, base);

  // ---- making a user ----
  // Invited: the sign-up (as the page sends it, with no password) succeeds with no session cookie and mails one set-password link and no verify link;
  // setting the password through it verifies the email, and that password then signs in.
  const signUpInvited = async (address: string, password: string, base?: string) => {
    const up = await authPost("/api/auth/sign-up/email", { name: "Gate", email: address, password: "" }, base);
    if (!up.ok) throw new Error(`invited sign-up for ${address} -> ${up.status}`);
    if (cookieOf(up)) throw new Error(`sign-up for ${address} set a cookie before the email was verified`);
    const [link] = await waitMails(SET_PASSWORD_SUBJECT, address, 1, base);
    if (!link) throw new Error(`no set-password mail for ${address} in the dev inbox`);
    if (await mailUrl("Verify your email", address, base)) throw new Error(`${address} got a plain verify link`);
    const set = await setPassword(link, password, base);
    if (!set.ok) throw new Error(`set-password for ${address} -> ${set.status}`);
    const inn = await authPost("/api/auth/sign-in/email", { email: address, password }, base);
    if (!inn.ok || !/session_token=/.test(cookieOf(inn))) throw new Error(`sign-in after set-password for ${address} -> ${inn.status}`);
    return cookieOf(inn);
  };
  // Returns the user's session cookie ("" when the options leave no session).
  const makeUser = async (address: string, u: MakeUser): Promise<string> => {
    const { password, name = "Gate", inviteLink = true, markVerified = true, prefix = "", requireSignIn = false, base } = u;
    if (o.inviteOnly) {
      if (inviteLink) return signUpInvited(address, password, base);
      if (!(await authPost("/api/auth/sign-up/email", { name, email: address, password: "" }, base)).ok) throw new Error(`${prefix}sign-up for ${address} failed`);
      return "";
    }
    if (!(await authPost("/api/auth/sign-up/email", { name, email: address, password }, base)).ok) throw new Error(`${prefix}sign-up for ${address} failed`);
    if (markVerified) onUser(address, "UPDATE user SET emailVerified = 1 WHERE id = ?");
    const inn = await authPost("/api/auth/sign-in/email", { email: address, password }, base);
    if (requireSignIn && !inn.ok) throw new Error(`${prefix}sign-in for ${address} -> ${inn.status}`);
    return cookieOf(inn);
  };

  return {
    app, envFile,
    get address() { return here; },
    start, restart,
    request, authPost,
    eachDb, findDb, withDb, hasUser, onUser, idOf,
    mailUrls, mailUrl, waitMails, follow, landing, resetToken, setPassword,
    makeUser,
  };
}
