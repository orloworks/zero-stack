import { expect, test } from "bun:test";
import { FEATURE_LIST, validateFlags } from "../../src/flags";
import { INVITE_ONLY_PLUGIN, composeAuthTs } from "../../src/installers/auth-ts";

// Every svelte flag combination (implications applied), as the composer sees it.
function* svelteConfigs() {
  const features = FEATURE_LIST.filter((f) => !f.frameworks || f.frameworks.includes("svelte"));
  for (let m = 0; m < 1 << features.length; m++) {
    const input: Record<string, unknown> = { name: "x", framework: "svelte" };
    features.forEach((f, i) => { if (m & (1 << i)) input[f.key] = true; });
    yield validateFlags(input as never).config;
  }
}

// The options object is `defineAuth(({ defaults }) => ({ ...defaults, <key>: ..., }))`; its keys are the two-space-indented `name:` lines.
const topKeys = (src: string) => [...src.matchAll(/^ {2}([A-Za-z]+):/gm)].map((m) => m[1]);

test("composed auth.ts has no duplicate top-level key, and one databaseHooks and one plugins key at most, for every flag combination", () => {
  let n = 0;
  for (const config of svelteConfigs()) {
    if (!config.auth) continue;
    const keys = topKeys(composeAuthTs(config));
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect({ config, dup }).toEqual({ config, dup: [] });
    n++;
  }
  expect(n).toBeGreaterThan(100);
});

test("invite-only still gates user creation inside the one databaseHooks object", () => {
  const { config } = validateFlags({ name: "x", framework: "svelte", inviteOnly: true });
  const src = composeAuthTs(config);
  expect(src.match(/databaseHooks:/g)).toHaveLength(1);
  expect(src).toContain('  databaseHooks: {\n    user: {\n      create: {\n        before: async (user) => {');
});

const compose = (o: object) => composeAuthTs(validateFlags({ name: "x", framework: "svelte", ...o }).config);

test("--admin composes the admin plugin, the guard, lastSignInAt and the delete hooks into the single plugins, databaseHooks and user keys", () => {
  const src = compose({ admin: true });
  for (const key of ["plugins", "databaseHooks", "user"]) expect(src.match(new RegExp(`^  ${key}:`, "gm"))).toHaveLength(1);
  for (const t of [
    'import { admin } from "better-auth/plugins";',
    'import { isAdmin, recordAudit, redactAudit } from "./src/admin";',
    'import { adminGuard } from "./src/admin-guard";',
    "{ defaults, env }",
    'admin({ bannedUserMessage: "This account has been blocked. Contact the site owner." })',
    "adminGuard({ isAdmin: (user) => isAdmin(env.ADMIN_EMAILS, user), audit: recordAudit })",
    "updateUser(session.userId, { lastSignInAt: new Date() })",
    'additionalFields: { lastSignInAt: { type: "date", required: false, input: false } }',
    "await redactAudit(user.email)",
  ])
    expect(src).toContain(t);
  expect(src).not.toContain("purgeUserFiles"); // no --storage
  expect(src).not.toContain("role"); // the guard is the only writer of role (O3): no hook here writes it
});

test("the storage purge is composed when (account deletion or admin) and storage (E8)", () => {
  expect(compose({ admin: true })).not.toContain("purgeUserFiles");
  expect(compose({ storage: true })).not.toContain("purgeUserFiles");
  const adminStorage = compose({ admin: true, storage: true });
  expect(adminStorage).toContain('import { purgeUserFiles } from "./src/storage";');
  expect(adminStorage).toContain("audit: recordAudit, purge: purgeUserFiles })"); // the guard purges before an admin delete
  expect(adminStorage).toContain("await purgeUserFiles(user.id)"); // the shared resweep
  expect(adminStorage).not.toContain("deleteUser"); // no --account-deletion
  expect(compose({ accountDeletion: true, storage: true })).toContain('import { purgeUserFiles } from "./src/storage";');
});

test("--admin with account deletion keeps the purge-first beforeDelete and moves the resweep to the shared hook", () => {
  const src = compose({ admin: true, accountDeletion: true, storage: true });
  expect(src).toContain("beforeDelete: async (user)");
  expect(src).not.toContain("afterDelete"); // one resweep, in databaseHooks.user.delete.after
  expect(src.match(/storage resweep failed/g)).toHaveLength(1);
  expect(src.match(/^  user:/gm)).toHaveLength(1);
  // without --admin the self-delete resweep stays where it was
  expect(compose({ accountDeletion: true, storage: true })).toContain("afterDelete: async (user)");
});

test("the reset mail subject is 'Set your password' for an unverified user's server-side request, only with --admin and --invite-only", () => {
  const both = compose({ admin: true, inviteOnly: true });
  expect(both).toContain('({ user, url }, request) => send(user.email, !request && user.emailVerified === false ? "Set your password" : "Reset your password", url)');
  expect(compose({ inviteOnly: true })).toContain('send(user.email, "Reset your password", url)');
  expect(compose({ admin: true })).toContain('send(user.email, "Reset your password", url)');
  expect(both.match(/^  databaseHooks:/gm)).toHaveLength(1);
  expect(both).toContain("SIGNUP_INVITE_ONLY"); // the invite gate and the admin hooks share one databaseHooks object
});

// D8: the invite-only after-hook, run against an in-memory verification table with the generated source's own free names stubbed.
test("a failed set-password send leaves no unexpired reset-password row, and the next accepted sign-in mails a link", async () => {
  const rows: { identifier: string; value: string; expiresAt: Date }[] = [];
  let failing = true;
  const mails: string[] = [];
  const user = { id: "u1", email: "a@example.com", emailVerified: false };
  const stubs = {
    createAuthMiddleware: (fn: unknown) => fn,
    isAPIError: () => false,
    signupAllowed: () => true,
    env: {},
    send: async (to: string) => {
      if (failing) throw new Error("mail down");
      mails.push(to);
    },
    APIError: Error,
  };
  const plugin = new Function(...Object.keys(stubs), `return (${INVITE_ONLY_PLUGIN});`)(...Object.values(stubs));
  const handler = plugin.hooks.after[0].handler;
  const ctx = {
    path: "/sign-in/email",
    body: { email: user.email },
    context: {
      returned: undefined,
      baseURL: "http://x",
      options: {},
      runInBackgroundOrAwait: (p: Promise<unknown>) => p,
      internalAdapter: {
        findUserByEmail: async () => ({ user }),
        createVerificationValue: async (r: (typeof rows)[number]) => void rows.push(r),
        deleteVerificationByIdentifier: async (id: string) => void rows.splice(0, rows.length, ...rows.filter((r) => r.identifier !== id)),
      },
      adapter: { findOne: async () => rows.find((r) => r.identifier.startsWith("reset-password:") && r.expiresAt > new Date()) ?? null },
    },
  };
  await expect(handler(ctx)).rejects.toThrow("mail down");
  expect(rows.filter((r) => r.expiresAt > new Date())).toEqual([]);
  // A failing delete keeps the send error, not the delete's.
  const del = ctx.context.internalAdapter.deleteVerificationByIdentifier;
  ctx.context.internalAdapter.deleteVerificationByIdentifier = async () => { throw new Error("db down"); };
  const quiet = console.error;
  console.error = () => {};
  try {
    await expect(handler(ctx)).rejects.toThrow("mail down");
  } finally {
    console.error = quiet;
    ctx.context.internalAdapter.deleteVerificationByIdentifier = del;
  }
  rows.length = 0;
  failing = false;
  await handler(ctx);
  expect(mails).toEqual([user.email]);
});

// E10: with --admin and --invite-only the three call sites read the env list and the database invites through inviteAllowed; without --admin nothing changes.
test("--admin --invite-only swaps all three signup re-checks to inviteAllowed, and the matcher import goes with them", () => {
  const src = compose({ admin: true, inviteOnly: true });
  expect(src).toContain('import { inviteAllowed } from "./src/invites";');
  expect(src.match(/inviteAllowed\(/g)).toHaveLength(3);
  expect(src.match(/if \(!\(await inviteAllowed\(user\.email, env\.SIGNUP_ALLOWLIST\)\)\)/g)).toHaveLength(2); // user-create hook, and the reset-password re-check
  expect(src).toContain("!(await inviteAllowed(found.user.email, env.SIGNUP_ALLOWLIST))"); // the set-password mail after-hook
  expect(src).not.toContain("signupAllowed");
  expect(src.match(/^  databaseHooks:/gm)).toHaveLength(1);
  const plain = compose({ inviteOnly: true });
  expect(plain).not.toContain("inviteAllowed");
  expect(plain.match(/signupAllowed\(env\.SIGNUP_ALLOWLIST/g)).toHaveLength(3);
  expect(compose({ admin: true })).not.toContain("inviteAllowed");
});
