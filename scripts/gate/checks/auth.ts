// Module 3: --auth, with its Turnstile, invite-only, storage, email and account-deletion steps woven in (one sequence, so one module).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnTracked } from "../../../src/children";
import { cookieOf } from "../harness";
import { authHelpers, type Ctx, GATE_ORIGIN, GATE_PW } from "../shared";

// What the allowlist checks read: the two users and the mailed link that the --invite-only part of the auth checks creates.
export type InviteUsers = { kept: string; pending: string; pendingLink: URL | undefined };

// Pre-build (#104, #132): a svelte app with auth runs with an app plugin in its auth extension (an allowed init, one hook and a trusted origin), so every check
// after the build also proves that zero-stack's protections (invite-only, cancel-before-delete, the admin guard) hold with the extension in use.
// The file contents live here, next to the checks that assert on them; gate.ts calls this before `vp check` and `vp build`.
export function writeAuthFixtures(app: string): void {
  writeFileSync(join(app, "src/app/auth.ts"), `import { APIError, createAuthMiddleware } from "better-auth/api";

export default function authExtension(_env: Record<string, unknown>) {
  return {
    plugins: [
      {
        id: "gate-app",
        init: async () => ({ options: { databaseHooks: { user: { create: { before: async () => ({ data: { image: "gate-app-db-hook" } }) } } } } }),
        hooks: {
          before: [
            {
              matcher: (ctx: { path?: string }) => ctx.path === "/sign-up/email",
              handler: createAuthMiddleware(async (ctx) => {
                if (ctx.body?.name === "gate-app-hook") throw new APIError("BAD_REQUEST", { code: "GATE_APP_HOOK", message: "Refused by the app hook." });
              }),
            },
          ],
        },
      },
    ],
    trustedOrigins: ["${GATE_ORIGIN}"],
  };
}
`);
  // #132: a requireAuth route every svelte auth app has for the signed-in helper's proof below (the example routes exist only with --admin).
  writeFileSync(join(app, "routes/api/gate-whoami.ts"), `import { defineHandler } from "void";
import { requireAuth } from "void/auth";

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return c.json({ id: user.id, emailVerified: user.emailVerified });
});
`);
}

export async function authChecks(ctx: Ctx, { port }: { port: number }): Promise<InviteUsers> {
  const { config, app, vp, h } = ctx;
  const { authPost, mailUrls, mailUrl, waitMails, SET_PW, setPassword, signInStatus, dropLinks, signUpVerified, inviteRefused, r2Keys } = authHelpers(h);
  const kept = `kept-${Date.now()}@example.com`, pending = `pending-${Date.now()}@example.com`;
  let pendingLink: URL | undefined;
  if (config.auth) {
    const base = `http://localhost:${port}`;
    const post = (path: string, body: object, cookie?: string) => h.authPost(path, body, base, cookie);
    const bare = (path: string, body: object) => h.request(path, { base, method: "POST", body });
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
    if (config.framework === "svelte") {
      // #104: the app plugin's hook refuses, its init's database hook ran for the user above, and its trusted origin is trusted (a foreign one is not).
      const hooked = await post("/api/auth/sign-up/email", { name: "gate-app-hook", email: `hook-${email}`, password });
      const hookedBody = (await hooked.json().catch(() => null)) as { code?: string } | null;
      if (hooked.status !== 400 || hookedBody?.code !== "GATE_APP_HOOK") throw new Error(`the app plugin's before hook did not run: sign-up -> ${hooked.status} ${JSON.stringify(hookedBody)}`);
      if (session.user.image !== "gate-app-db-hook") throw new Error("the app plugin's init database hook did not run for a new user");
      const from = (origin: string) => h.request("/api/auth/sign-in/email", { base, method: "POST", body: { email, password }, origin: { foreign: origin }, cookie, captcha: !!config.turnstile });
      const [trusted, foreign] = [await from(GATE_ORIGIN), await from("https://evil.example")];
      if (!trusted.ok || foreign.status !== 403) throw new Error(`trusted origins: the app's origin -> ${trusted.status} (want 200), a foreign origin -> ${foreign.status} (want 403)`);
      console.log("gate: auth extension: the app plugin's hook and database hook run, its trusted origin is trusted, a foreign origin is refused");
      // #132: the generated tests/signed-in.ts test, plus a test of the gate's own: the helper's cookie gets 200 and emailVerified true from a requireAuth route (a
      // request with no cookie gets 401), with no captcha, mail or sign-in call, and with --admin an ordinary helper user is 404 on /admin and an admin helper user 200.
      writeFileSync(join(app, "tests/gate-signed-in.test.ts"), `import { expect, it } from "vite-plus/test";
import { signedIn } from "./signed-in";

const url = process.env.DEV_URL!;
it("a requireAuth route accepts the helper's user", async () => {
  const { headers, user } = await signedIn();
  const res = await fetch(\`\${url}/api/gate-whoami\`, { headers });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: user.id, emailVerified: true });
  expect((await fetch(\`\${url}/api/gate-whoami\`)).status).toBe(401);
}, 60_000);
${config.admin ? `it("with --admin, only the admin helper user gets /admin", async () => {
  expect((await fetch(\`\${url}/admin\`, { headers: (await signedIn()).headers })).status).toBe(404);
  const admin = await signedIn({ admin: true });
  expect((await fetch(\`\${url}/admin\`, { headers: admin.headers })).status).toBe(200);
  expect((await signedIn({ email: admin.user.email })).user.id).toBe(admin.user.id);
}, 60_000);
` : ""}`);
      const proof = spawnTracked([vp, "test", "tests/signed-in.test.ts", "tests/gate-signed-in.test.ts"], { cwd: app, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, DEV_URL: base } });
      if ((await proof.exited) !== 0) throw new Error("the signed-in helper tests failed against the dev server");
      console.log(`gate: signed-in helper: a verified user (${config.turnstile ? "Turnstile on, no captcha token" : "no Turnstile"}) gets 200 from a requireAuth route${config.admin ? "; /admin is 404 for an ordinary one and 200 for an admin one" : ""}`);
    }
    // --invite-only: the create hook refuses before any row or mail. The scaffold's list is @example.com; `kept` is an existing user for the restarts below.
    if (config.inviteOnly) {
      await signUpVerified(base, kept);
      const refused = [`nobody-${Date.now()}@evilexample.com`, `nobody-${Date.now()}@sub.example.com`, `NOBODY-${Date.now()}@EVILEXAMPLE.COM`, `a@b@example.com`, `nobody-${Date.now()}@exаmple.com`];
      for (const a of refused) await inviteRefused(base, a);
      await signUpVerified(base, `Upper-${Date.now()}@EXAMPLE.COM`); // a domain entry admits an upper-case match
      if (!(await authPost(base, "/api/auth/sign-in/email", { email: kept, password: GATE_PW })).ok) throw new Error("a verified user could not sign in");
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
      const raw = (path: string, body: object, origin: string) => h.request(path, { base, method: "POST", body, origin: { foreign: origin }, captcha: !!config.turnstile });
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
        const bad = await h.landing(new URL(link.pathname.replace(/[^/]+$/, "not-a-token") + link.search, base), base);
        if (bad.pathname !== "/reset-password" || bad.searchParams.get("error") !== "INVALID_TOKEN") throw new Error(`bad reset token landed on ${bad}`);
        const resetToken = await h.resetToken(link, "reset", base);
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
  return { kept, pending, pendingLink };
}
