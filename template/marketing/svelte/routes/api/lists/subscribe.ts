import { defineHandler } from "void";
import { env } from "void/env";
import { requireSameOrigin } from "../../../src/admin";
import { CHECK_INBOX, requestJoin } from "../../../src/consent";
import { fields } from "../../../src/lib/fields";
import { turnstileSecret } from "../../../src/turnstile-guard";
import { verifyTurnstile } from "../../../src/turnstile-verify";

// Public: no account needed. It checks the Turnstile token itself (header x-captcha-response, or the form field Cloudflare's widget adds), and answers the same
// "Check your inbox to confirm" for every address, new, pending, confirmed or unsubscribed, so it cannot be used to find out who subscribes.
export const POST = defineHandler(async (c) => {
  requireSameOrigin(c);
  const f = await fields(c);
  const token = c.req.header("x-captcha-response") ?? f["cf-turnstile-response"] ?? "";
  if (!(await verifyTurnstile(token, turnstileSecret(env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_URL)))) return c.json({ message: "The verification check failed. Reload the page and try again." }, 400);
  try {
    const out = await requestJoin(f.email, f.list ?? "newsletter", { origin: new URL(c.req.url).origin, page: "/subscribe" });
    if (out === "bad-email") return c.json({ message: "Enter a valid email address." }, 400);
    if (out === "bad-list") return c.json({ message: "That list doesn't exist." }, 400);
  } catch (e) {
    console.error("subscribe confirmation mail failed", e instanceof Error ? e.message : "unknown error");
    return c.json({ message: "Couldn't send the confirmation mail. Try again later." }, 502);
  }
  return c.json({ message: CHECK_INBOX });
});
