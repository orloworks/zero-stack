import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { expect, it, vi } from "vite-plus/test";
import { revokeUnprovenSessions } from "../src/admin-takeover";

// A real Better Auth instance over memory, wired as auth.ts wires it: sign-up signs the person in and mails a verify link; the guard is the update hook.
// An attacker signs up as a listed address, the inbox owner verifies it; only the owner may end up able to sign in.
const PW = "attacker-chosen-password";
const SLOW = 30_000;
const LISTED = "owner@x.com";
function setup(opts: { resetMailFails?: boolean; raceSession?: boolean } = {}) {
  const db: Record<string, any[]> = { user: [], session: [], account: [], verification: [] };
  const mail: { verify: string[]; reset: { to: string; url: string }[] } = { verify: [], reset: [] };
  const auth = betterAuth({
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:5173",
    database: memoryAdapter(db),
    // Hashing is not under test (scrypt makes every sign-up slow).
    emailAndPassword: {
      enabled: true,
      revokeSessionsOnPasswordReset: true,
      password: { hash: async (p) => p, verify: async ({ hash, password }) => hash === password },
      sendResetPassword: async ({ user, url }) => {
        if (opts.resetMailFails) throw new Error("mail down");
        mail.reset.push({ to: user.email, url });
      },
    },
    emailVerification: { sendOnSignUp: true, sendVerificationEmail: async ({ url }) => void mail.verify.push(url) },
    databaseHooks: { user: { update: { after: (u, ctx) => hook(u as any, !opts.raceSession || !ctx ? ctx : raced(ctx)) } } },
  });
  const hook = revokeUnprovenSessions((u) => u.emailVerified && u.email === LISTED);
  // A sign-in on another isolate that read the user before the sessions were deleted: its session lands right after the first delete.
  const raced = (ctx: any) => {
    const ia = ctx.context.internalAdapter;
    let first = true;
    const deleteUserSessions = async (id: string) => {
      await ia.deleteUserSessions(id);
      if (first) await ctx.context.adapter.create({ model: "session", data: { token: "raced", userId: id, expiresAt: new Date(Date.now() + 1e6), createdAt: new Date(), updatedAt: new Date() } });
      first = false;
    };
    return { ...ctx, context: { ...ctx.context, internalAdapter: { ...ia, deleteUserSessions } } };
  };
  // Signs `email` up with the attacker's password, keeps the session cookie, and returns the link the address's inbox received.
  const signUp = async (email: string) => {
    const { headers } = await auth.api.signUpEmail({ body: { name: email, email, password: PW }, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { headers: new Headers({ cookie }), link: mail.verify.at(-1)! };
  };
  const verify = (link: string) => auth.api.verifyEmail({ query: { token: new URL(link).searchParams.get("token")! } });
  const signsIn = (email: string, password: string) => auth.api.signInEmail({ body: { email, password } }).then(() => true, () => false);
  return { auth, db, mail, signUp, verify, signsIn };
}

it("verifying a listed address ends the sign-up session and password and mails the address a set-password link", async () => {
  const t = setup();
  const { headers, link } = await t.signUp(LISTED);
  expect((await t.auth.api.getSession({ headers }))?.user.email).toBe(LISTED); // before verification the attacker is signed in
  await t.verify(link);
  expect(t.db.user![0].emailVerified).toBe(true); // the verification stands
  expect(await t.auth.api.getSession({ headers })).toBeNull();
  expect(t.db.session).toHaveLength(0);
  expect(await t.signsIn(LISTED, PW)).toBe(false);
  expect(t.mail.reset.map((m) => m.to)).toEqual([LISTED]);
  // The link works: the owner sets a password and signs in with it, and only with it.
  const token = new URL(t.mail.reset[0]!.url).pathname.split("/").pop()!;
  await t.auth.api.resetPassword({ body: { newPassword: "owner-password", token } });
  expect(await t.signsIn(LISTED, "owner-password")).toBe(true);
  expect(await t.signsIn(LISTED, PW)).toBe(false);
}, SLOW);

it("an unlisted address keeps its session and password through verification, and no reset mail goes out", async () => {
  const t = setup();
  const { headers, link } = await t.signUp("someone@x.com");
  await t.verify(link);
  expect((await t.auth.api.getSession({ headers }))?.user.email).toBe("someone@x.com");
  expect(await t.signsIn("someone@x.com", PW)).toBe(true);
  expect(t.mail.reset).toEqual([]);
}, SLOW);

it("a failed reset mail is logged and does not undo the verification or the revocation; Forgot password still works", async () => {
  const t = setup({ resetMailFails: true });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { headers, link } = await t.signUp(LISTED);
  await t.verify(link);
  expect(log).toHaveBeenCalled();
  log.mockRestore();
  expect(t.db.user![0].emailVerified).toBe(true);
  expect(await t.auth.api.getSession({ headers })).toBeNull();
  expect(await t.signsIn(LISTED, PW)).toBe(false);
}, SLOW);

it("signing in again later (a lastSignInAt-style update) does not reset a listed, verified owner", async () => {
  const t = setup();
  const { link } = await t.signUp(LISTED);
  await t.verify(link);
  const token = new URL(t.mail.reset[0]!.url).pathname.split("/").pop()!;
  await t.auth.api.resetPassword({ body: { newPassword: "owner-password", token } });
  await t.signsIn(LISTED, "owner-password");
  const { headers } = await t.auth.api.signInEmail({ body: { email: LISTED, password: "owner-password" }, returnHeaders: true });
  await t.auth.api.updateUser({ headers: new Headers({ cookie: headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }), body: { name: "Owner" } });
  expect(t.mail.reset).toHaveLength(1);
  expect(await t.signsIn(LISTED, "owner-password")).toBe(true);
}, SLOW);

it("a session that lands after the first sweep is gone when /verify-email completes", async () => {
  const t = setup({ raceSession: true });
  const { link } = await t.signUp(LISTED);
  await t.verify(link);
  expect(t.db.session).toHaveLength(0);
}, SLOW);

it("an unsent set-password token is deleted when the mail fails", async () => {
  const t = setup({ resetMailFails: true });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { link } = await t.signUp(LISTED);
  await t.verify(link);
  log.mockRestore();
  expect(t.db.verification.filter((v) => v.identifier.startsWith("reset-password:"))).toHaveLength(0);
}, SLOW);
