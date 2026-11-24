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
    expect(src).toContain("stripeClient: stripeClient(env.STRIPE_SECRET_KEY, env.STRIPE_API_URL)");
    expect(src).toContain("onEvent: confirmStripeEvent");
    expect(src).toContain("billingGuard({ configured: stripeConfigured(env.STRIPE_SECRET_KEY) })");
    expect(src).toContain('import { stripe } from "@better-auth/stripe";');
    expect(src).toContain("defineAuth(({ defaults, env })");
    expect(src.match(/^ {2}plugins:/gm)).toHaveLength(1);
  }
  expect(composeAuthTs(cfg({ admin: true }))).not.toMatch(/stripe|billingGuard|customRules/i);
});

test("--payments declares the Stripe keys in env.ts and ships placeholders in .env", () => {
  const env = composeEnvTs(cfg({ payments: true }))!;
  for (const k of ["STRIPE_SECRET_KEY: string(),", "STRIPE_WEBHOOK_SECRET: string(),", "STRIPE_API_URL: string().optional(),"]) expect(env).toContain(k);
  expect(authEnv(cfg({ payments: true }))).toContain("STRIPE_SECRET_KEY=sk_test_placeholder\nSTRIPE_WEBHOOK_SECRET=whsec_placeholder\n");
  expect(authEnv(cfg({}))).not.toContain("STRIPE");
});

test("the matrix runs --payments without --admin, and svelte-all picks it up from the table", () => {
  expect(MATRIX.find((p) => p.name === "svelte-payments")?.args).toEqual(["--framework", "svelte", "--auth", "--payments"]);
  expect(MATRIX.find((p) => p.name === "svelte-all")!.args).toContain("--payments");
});
