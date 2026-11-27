// Stripe's webhook signature header (Web Crypto HMAC, as Stripe does): `t=<seconds>,v1=<hex hmac of "t.payload">`. Pure; `nowMs` is injectable for tests.
export const signWebhook = async (payload: string, secret: string, nowMs = Date.now()): Promise<string> => {
  const t = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
};
