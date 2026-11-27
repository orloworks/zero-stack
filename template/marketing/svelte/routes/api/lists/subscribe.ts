import { defineHandler } from "void";
import { env } from "void/env";
import { requireSameOrigin } from "../../../src/admin";
import { CHECK_INBOX, LISTS, parseJoin, requestJoin } from "../../../src/consent";
import { afterResponse } from "../../../src/lib/after-response";
import { fields } from "../../../src/lib/fields";
import { turnstileSecret } from "../../../src/turnstile-guard";
import { verifyTurnstile } from "../../../src/turnstile-verify";

// Public: no account needed. It checks the Turnstile token itself (header x-captcha-response, or the form field Cloudflare's widget adds), then answers
// "Check your inbox to confirm" at once for every address, new, pending, confirmed or unsubscribed: the claim and the mail happen after the response, so neither the
// answer nor its timing says who subscribes. A mail that fails is logged, and the next request can try again.
export const POST = defineHandler(async (c) => {
  requireSameOrigin(c);
  const f = await fields(c);
  const token = c.req.header("x-captcha-response") ?? f["cf-turnstile-response"] ?? "";
  if (!(await verifyTurnstile(token, turnstileSecret(env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_URL)))) return c.json({ message: "The verification check failed. Reload the page and try again." }, 400);
  const join = parseJoin(f.email, f.list ?? LISTS[0]?.name);
  if (join === "bad-email") return c.json({ message: "Enter a valid email address." }, 400);
  if (join === "bad-list") return c.json({ message: "That list doesn't exist." }, 400);
  afterResponse(c, requestJoin(join.email, join.list.name, { origin: new URL(c.req.url).origin, page: "/subscribe" }), "subscribe confirmation mail");
  return c.json({ message: CHECK_INBOX });
});
