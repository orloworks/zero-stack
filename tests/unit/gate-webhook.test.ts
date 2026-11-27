import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { signWebhook } from "../../scripts/gate/webhook";

const mac = (secret: string, t: number, payload: string) => createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

test("signWebhook makes Stripe's t=<seconds>,v1=<hmac of t.payload> header", async () => {
  const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const header = await signWebhook(payload, "whsec_test", 1_700_000_123_456);
  expect(header).toBe(`t=1700000123,v1=${mac("whsec_test", 1_700_000_123, payload)}`);
});

test("the signature depends on the payload, the secret and the time", async () => {
  const [a, b, c, d] = await Promise.all([
    signWebhook("{}", "s1", 1_000_000), signWebhook("{ }", "s1", 1_000_000), signWebhook("{}", "s2", 1_000_000), signWebhook("{}", "s1", 2_000_000),
  ]);
  expect(new Set([a, b, c, d]).size).toBe(4);
});

test("with no time given it signs for now", async () => {
  const before = Math.floor(Date.now() / 1000);
  const t = Number((await signWebhook("{}", "s")).match(/^t=(\d+),v1=[0-9a-f]{64}$/)![1]);
  expect(t).toBeGreaterThanOrEqual(before);
  expect(t).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
});
