// Cloudflare's documented test secrets (developers.cloudflare.com/turnstile/troubleshooting/testing): always pass, always fail, token already spent.
const TEST_SECRETS = ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Returns the secret, or throws at startup when a test secret would guard a non-local deployment (a test secret accepts any token).
// An absent secret passes through as "": Void evaluates auth.ts at build time with no server env, and env.ts (required, no default)
// is what stops a deploy without it; at runtime the captcha plugin answers an empty secret with a 500, never a pass.
export function turnstileSecret(secret: unknown, authUrl: unknown): string {
  if (!secret) return "";
  if (!TEST_SECRETS.includes(secret as string)) return secret as string;
  let host = "";
  try {
    host = new URL(String(authUrl ?? "")).hostname;
  } catch {}
  if (!LOCAL_HOSTS.includes(host))
    throw new Error("TURNSTILE_SECRET_KEY is a Cloudflare test secret but BETTER_AUTH_URL is not localhost. Set the real secret: void secret put TURNSTILE_SECRET_KEY.");
  return secret as string;
}
