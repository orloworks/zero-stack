import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { expect, it } from "vite-plus/test";
import { adminGuard } from "../src/admin-guard";

// The real Better Auth server API over an in-memory database: the guard's hooks run for auth.api calls exactly as for HTTP requests.
const PW = "correct-horse-battery";
const SLOW = 30_000; // a loaded machine: the default 5s is for tests that do not build a Better Auth instance
function setup(opts: { purgeFails?: boolean; auditFails?: boolean } = {}) {
  const db: Record<string, any[]> = { user: [], session: [], account: [], verification: [] };
  const listed = new Set<string>();
  const audit: any[] = [];
  const purged: string[] = [];
  const state = { ...opts };
  const auth = betterAuth({
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:5173",
    database: memoryAdapter(db),
    // The guard is under test, not password hashing (scrypt makes every sign-up slow, and slower still on a busy machine).
    emailAndPassword: { enabled: true, password: { hash: async (p) => p, verify: async ({ hash, password }) => hash === password } },
    plugins: [
      admin(),
      adminGuard({
        isAdmin: (u) => u.emailVerified && listed.has(u.email),
        audit: async (i) => {
          if (state.auditFails) throw new Error("d1 down");
          audit.push(i);
        },
        purge: async (id) => {
          if (state.purgeFails) throw new Error("r2 down");
          purged.push(id);
        },
      }),
    ],
  });
  // A signed-in user: their email is verified when asked, and their cookie is their session.
  const user = async (email: string, verified = true) => {
    await auth.api.signUpEmail({ body: { name: email, email, password: PW } });
    const row = db.user!.find((u) => u.email === email)!;
    row.emailVerified = verified;
    const { headers } = await auth.api.signInEmail({ body: { email, password: PW }, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return { id: row.id as string, row, headers: new Headers({ cookie }) };
  };
  return { auth, db, listed, audit, purged, state, user };
}
const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => (e as { statusCode: number }).statusCode);
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { body?: { code?: string } }).body?.code);

it("answers 404 to every allowlisted endpoint for signed out, non-admin and listed-but-unverified callers", async () => {
  const t = setup();
  const plain = await t.user("plain@x.com");
  const unverified = await t.user("owner@x.com", false);
  t.listed.add("owner@x.com");
  const calls = (headers?: Headers) => [
    t.auth.api.listUsers({ headers, query: {} }),
    t.auth.api.getUser({ headers, query: { id: plain.id } }),
    t.auth.api.listUserSessions({ headers, body: { userId: plain.id } }),
    t.auth.api.banUser({ headers, body: { userId: plain.id } }),
    t.auth.api.unbanUser({ headers, body: { userId: plain.id } }),
    t.auth.api.revokeUserSession({ headers, body: { sessionToken: "x" } }),
    t.auth.api.revokeUserSessions({ headers, body: { userId: plain.id } }),
    t.auth.api.removeUser({ headers, body: { userId: plain.id } }),
  ];
  for (const headers of [undefined, plain.headers, unverified.headers]) expect(await Promise.all(calls(headers).map(status))).toEqual(Array(8).fill(404));
  expect(t.audit).toEqual([]);
  expect(t.purged).toEqual([]);
}, SLOW);

it("follows ADMIN_EMAILS live on an existing session, in both directions, and is the only writer of role (O3)", async () => {
  const t = setup();
  const owner = await t.user("owner@x.com", false);
  t.listed.add("owner@x.com");
  expect(await status(t.auth.api.listUsers({ headers: owner.headers, query: {} }))).toBe(404); // listed, not verified yet
  owner.row.emailVerified = true; // verified after signing in
  expect(await status(t.auth.api.listUsers({ headers: owner.headers, query: {} }))).toBe(200);
  expect(owner.row.role).toBe("admin");
  t.listed.delete("owner@x.com"); // de-listed: the live session stops working at once
  expect(await status(t.auth.api.listUsers({ headers: owner.headers, query: {} }))).toBe(404);
  expect(owner.row.role).toBe("user");
  t.listed.add("owner@x.com"); // listed again, same session
  expect(await status(t.auth.api.listUsers({ headers: owner.headers, query: {} }))).toBe(200);
}, SLOW);

it("refuses every endpoint off the allowlist, even for an admin", async () => {
  const t = setup();
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const other = await t.user("other@x.com");
  const h = boss.headers;
  const refused = [
    t.auth.api.setRole({ headers: h, body: { userId: other.id, role: "admin" } }),
    t.auth.api.createUser({ headers: h, body: { email: "new@x.com", password: PW, name: "n", role: "user" } }),
    t.auth.api.adminUpdateUser({ headers: h, body: { userId: other.id, data: { name: "x" } } }),
    t.auth.api.setUserPassword({ headers: h, body: { userId: other.id, newPassword: "a-new-password-1" } }),
    t.auth.api.impersonateUser({ headers: h, body: { userId: other.id } }),
    t.auth.api.stopImpersonating({ headers: h }),
    t.auth.api.userHasPermission({ headers: h, body: { permissions: { user: ["list"] } } }),
    t.auth.api.listUserSessions({ headers: h, body: { userId: other.id } }), // returns raw tokens
  ];
  expect(await Promise.all(refused.map(status))).toEqual(Array(8).fill(404));
  expect(other.row.role).toBe("user");
  expect(t.db.user!.length).toBe(2);
}, SLOW);

it("a ban writes one audit entry, and a self-ban is refused without one", async () => {
  const t = setup();
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  expect(await status(t.auth.api.banUser({ headers: boss.headers, body: { userId: victim.id, banReason: " spam " } }))).toBe(200);
  expect(t.audit).toEqual([{ actor: { id: boss.id, email: "boss@x.com" }, verb: "ban", target: { id: victim.id, email: "victim@x.com" }, detail: "spam", oldValue: "active", newValue: "banned" }]);
  expect(t.db.session!.some((s) => s.userId === victim.id)).toBe(false); // the plugin ended their sessions
  expect(await status(t.auth.api.unbanUser({ headers: boss.headers, body: { userId: victim.id } }))).toBe(200);
  expect(t.audit[1]).toMatchObject({ verb: "unban", oldValue: "banned", newValue: "active" });
  expect(await status(t.auth.api.banUser({ headers: boss.headers, body: { userId: boss.id } }))).toBe(400);
  expect(t.audit).toHaveLength(2);
}, SLOW);

it("a failed audit write answers 500 AUDIT_WRITE_FAILED after the change was made", async () => {
  const t = setup({ auditFails: true });
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  expect(await code(t.auth.api.banUser({ headers: boss.headers, body: { userId: victim.id } }))).toBe("AUDIT_WRITE_FAILED");
  expect(t.db.user!.find((u) => u.id === victim.id)!.banned).toBe(true); // the change stands
}, SLOW);

it("revoking a session audits the session's user, found from its token", async () => {
  const t = setup();
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  const token = t.db.session!.find((s) => s.userId === victim.id)!.token;
  expect(await status(t.auth.api.revokeUserSession({ headers: boss.headers, body: { sessionToken: token } }))).toBe(200);
  expect(t.audit).toEqual([{ actor: { id: boss.id, email: "boss@x.com" }, verb: "revoke-session", target: { id: victim.id, email: "victim@x.com" } }]);
  expect(await status(t.auth.api.revokeUserSessions({ headers: boss.headers, body: { userId: victim.id } }))).toBe(200);
  expect(t.audit[1]).toMatchObject({ verb: "revoke-sessions", target: { id: victim.id } });
}, SLOW);

it("delete purges the user's files first and refuses, leaving everything intact, when the purge fails (U1)", async () => {
  const t = setup({ purgeFails: true });
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  expect(await code(t.auth.api.removeUser({ headers: boss.headers, body: { userId: victim.id } }))).toBe("STORAGE_PURGE_FAILED");
  expect(t.db.user!.some((u) => u.id === victim.id)).toBe(true);
  expect(t.db.account!.some((a) => a.userId === victim.id)).toBe(true); // the sign-in still works: nothing was deleted before the purge
  expect(t.audit).toEqual([]);
  t.state.purgeFails = false;
  expect(await status(t.auth.api.removeUser({ headers: boss.headers, body: { userId: victim.id } }))).toBe(200);
  expect(t.purged).toEqual([victim.id]);
  expect(t.db.user!.some((u) => u.id === victim.id)).toBe(false);
  // O1: no target id, no email, no free text beyond the action and the id
  expect(t.audit).toEqual([{ actor: { id: boss.id, email: "boss@x.com" }, verb: "delete-user", target: null, detail: `deleted user ${victim.id}` }]);
}, SLOW);

it("a self-delete is refused before anything is purged", async () => {
  const t = setup();
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  expect(await status(t.auth.api.removeUser({ headers: boss.headers, body: { userId: boss.id } }))).toBe(400);
  expect(t.purged).toEqual([]);
  expect(t.db.user!.some((u) => u.id === boss.id)).toBe(true);
}, SLOW);

it("a userId that is not a string is refused with 400 before anything runs (the plugin would coerce [id] to id)", async () => {
  const t = setup({ purgeFails: true });
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  const bad = [[victim.id], 7, { id: victim.id }, null];
  for (const userId of bad) {
    for (const call of ["banUser", "unbanUser", "revokeUserSessions", "removeUser"] as const) {
      expect(await status((t.auth.api[call] as any)({ headers: boss.headers, body: { userId } }))).toBe(400);
    }
  }
  expect(t.db.user!.find((u) => u.id === victim.id)!.banned).toBeFalsy();
  expect(t.db.user!.some((u) => u.id === victim.id)).toBe(true); // remove-user with the purge down: nothing deleted, nothing purged
  expect(t.db.account!.some((a) => a.userId === victim.id)).toBe(true);
  expect(t.purged).toEqual([]);
  expect(t.audit).toEqual([]);
}, SLOW);

it("a ban or unban that changes nothing writes no audit entry", async () => {
  const t = setup();
  const boss = await t.user("boss@x.com");
  t.listed.add("boss@x.com");
  const victim = await t.user("victim@x.com");
  expect(await status(t.auth.api.unbanUser({ headers: boss.headers, body: { userId: victim.id } }))).toBe(200); // not banned
  expect(t.audit).toEqual([]);
  await t.auth.api.banUser({ headers: boss.headers, body: { userId: victim.id } });
  await t.auth.api.banUser({ headers: boss.headers, body: { userId: victim.id } }); // already banned
  expect(t.audit.map((a) => a.verb)).toEqual(["ban"]);
}, SLOW);
