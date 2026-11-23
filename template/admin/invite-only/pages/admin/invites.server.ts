import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { requireAdmin } from "../../src/admin";
import { listInvites, secretEntries } from "../../src/invites";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  requireAdmin(c);
  // "[Invite them]" on a no-match search opens this page with the address filled in (D7).
  const prefill = (c.req.query("email") ?? "").trim().slice(0, 254);
  const secret = secretEntries(env.SIGNUP_ALLOWLIST);
  try {
    return { prefill, secret, invites: await listInvites(), loadError: false };
  } catch (e) {
    console.error("admin invites load failed", e);
    return { prefill, secret, invites: [], loadError: true };
  }
});
