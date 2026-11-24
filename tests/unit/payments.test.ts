import { expect, test } from "bun:test";
import { MATRIX } from "../../scripts/matrix";
import { validateFlags } from "../../src/flags";
import { authEnv } from "../../src/installers/auth";
import { composeAuthTs } from "../../src/installers/auth-ts";
import { composeEnvTs } from "../../src/installers/env-ts";

const cfg = (o: object) => validateFlags({ name: "x", framework: "svelte", ...o } as never).config;

test("--payments implies auth, saying so, and is refused off svelte", () => {
  const r = validateFlags({ name: "x", framework: "svelte", payments: true });
  expect(r.config).toMatchObject({ payments: true, auth: true, email: false, admin: false });
  expect(r.notes).toEqual(["--payments implies --auth; enabling auth."]);
  for (const framework of ["react", "vue", "solid"])
    expect(() => validateFlags({ name: "x", framework, payments: true })).toThrow("--payments requires --framework svelte");
});

test("--payments composes the Stripe plugin, the billing guard and the webhook rate-limit exemption into the one plugins key", () => {
  for (const o of [{ payments: true }, { payments: true, admin: true, turnstile: true, inviteOnly: true }]) {
    const src = composeAuthTs(cfg(o));
    expect(src).toContain('rateLimit: { storage: "database", customRules: { "/stripe/webhook": false } },');
    expect(src).toContain("...billingPlugins(env)");
    expect(src).toContain(`import { billingPlugins${"admin" in o ? ", cancelSubscriptions, deleteSubscriptionRows" : ""} } from "./src/billing";`);
    expect(src).toContain("defineAuth(({ defaults, env })");
    expect(src.match(/^ {2}plugins:/gm)).toHaveLength(1);
  }
  expect(composeAuthTs(cfg({ admin: true }))).not.toMatch(/stripe|billing|customRules/i);
});

test("--payments declares the Stripe keys in env.ts and ships placeholders in .env", () => {
  const env = composeEnvTs(cfg({ payments: true }))!;
  for (const k of ["STRIPE_SECRET_KEY: string(),", "STRIPE_WEBHOOK_SECRET: string(),", "STRIPE_API_URL: string().optional(),"]) expect(env).toContain(k);
  expect(authEnv(cfg({ payments: true }))).toContain("STRIPE_SECRET_KEY=sk_test_placeholder\nSTRIPE_WEBHOOK_SECRET=whsec_placeholder\n");
  expect(authEnv(cfg({}))).not.toContain("STRIPE");
});

test("the matrix runs --payments without --admin, and svelte-all picks it up from the table", () => {
  expect(MATRIX.find((p) => p.name === "svelte-payments")?.args).toEqual(["--framework", "svelte", "--auth", "--payments", "--account-deletion"]);
  expect(MATRIX.find((p) => p.name === "svelte-payments-admin")?.args).toEqual(["--framework", "svelte", "--auth", "--payments", "--admin"]);
  expect(MATRIX.find((p) => p.name === "svelte-all")!.args).toContain("--payments");
});

test("--payments cancels subscriptions before a user is deleted, ahead of the storage purge, on both paths (#84)", () => {
  // Self-service: deleteUser.beforeDelete, alone and ahead of the purge.
  const self = composeAuthTs(cfg({ payments: true, accountDeletion: true }));
  expect(self).toContain("      beforeDelete: async (user) => {\n        await cancelSubscriptions(env, user.id);\n      },");
  expect(self).toContain('import { billingPlugins, cancelSubscriptions, deleteSubscriptionRows } from "./src/billing";');
  const stored = composeAuthTs(cfg({ payments: true, accountDeletion: true, storage: true }));
  expect(stored.match(/beforeDelete:/g)).toHaveLength(1);
  expect(stored.indexOf("await cancelSubscriptions(env, user.id);")).toBeGreaterThan(stored.indexOf("beforeDelete:"));
  expect(stored.indexOf("await cancelSubscriptions(env, user.id);")).toBeLessThan(stored.indexOf("await purgeUserFiles(user.id);"));
  expect(stored).toContain("afterDelete:");
  // Admin removal: the guard gets the same helper; it calls it ahead of its purge.
  const admin = composeAuthTs(cfg({ payments: true, admin: true, storage: true }));
  expect(admin).toContain("purge: purgeUserFiles, cancelBilling: (id) => cancelSubscriptions(env, id) })");
  expect(admin).not.toContain("beforeDelete:");
  // After any deletion the plugin's rows go, in the one databaseHooks delete entry.
  for (const src of [self, stored, admin, composeAuthTs(cfg({ payments: true, admin: true, accountDeletion: true, storage: true, inviteOnly: true }))]) {
    expect(src.match(/^ {6}delete: \{/gm)).toHaveLength(1);
    expect(src.match(/^ {2}databaseHooks:/gm)).toHaveLength(1);
    expect(src).toContain("await deleteSubscriptionRows(user.id);");
  }
  expect(admin.indexOf("await redactAudit(user.email);")).toBeLessThan(admin.indexOf("await deleteSubscriptionRows(user.id);"));
  // No deletion path, or no payments: nothing is composed.
  expect(composeAuthTs(cfg({ payments: true }))).not.toMatch(/cancelSubscriptions|deleteSubscriptionRows|databaseHooks/);
  for (const o of [{ accountDeletion: true, storage: true }, { admin: true, storage: true, accountDeletion: true }]) expect(composeAuthTs(cfg(o))).not.toMatch(/cancelSubscriptions|deleteSubscriptionRows|cancelBilling/);
});
