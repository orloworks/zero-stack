import Stripe from "stripe";

// The scaffold's .env values: the app serves with them, and payment routes answer "Stripe isn't set up yet." until real keys replace them.
export const PLACEHOLDER_KEY = "sk_test_placeholder";
export const PLACEHOLDER_WEBHOOK_SECRET = "whsec_placeholder";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export const stripeConfigured = (key: unknown): boolean => typeof key === "string" && key.length > 0 && key !== PLACEHOLDER_KEY;

// The one Stripe client. `apiUrl` (STRIPE_API_URL) points it at a fake Stripe in tests and is refused at startup unless it is on this machine,
// so a stray value can never send a live key elsewhere. An absent key becomes the placeholder: Void evaluates auth.ts at build time with no server env.
export function stripeClient(key: unknown, apiUrl?: unknown): Stripe {
  const apiKey = typeof key === "string" && key ? key : PLACEHOLDER_KEY;
  if (!apiUrl) return new Stripe(apiKey);
  let url: URL | undefined;
  try {
    url = new URL(String(apiUrl));
  } catch {}
  if (!url || !LOCAL_HOSTS.includes(url.hostname))
    throw new Error("STRIPE_API_URL is for tests only and must point at localhost. Remove it to use Stripe.");
  return new Stripe(apiKey, { host: url.hostname, port: url.port, protocol: url.protocol === "https:" ? "https" : "http" });
}
