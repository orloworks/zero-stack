// The server-side Turnstile check for routes that are not Better Auth's (the subscribe route). Fails closed: no token, no secret, a network error, a non-2xx answer
// or anything but `success: true` is a refusal. An empty token is refused before Cloudflare is called, because the always-pass test secret accepts anything.
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(token: string, secret: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  if (!token || token.length > 2048 || !secret) return false;
  try {
    const res = await doFetch(SITEVERIFY, { method: "POST", body: new URLSearchParams({ secret, response: token }) });
    return res.ok && ((await res.json()) as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}
