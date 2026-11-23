import { defineHandler } from "void";
import { requireAdmin, requireSameOrigin } from "../../../../../src/admin";
import { sendInvite } from "../../../../../src/invites";

// Mails an exact-email invitee the sign-up link. It answers "requested", never "sent": the mail provider can still fail after we hand it the message.
export const POST = defineHandler(async (c) => {
  const me = requireAdmin(c);
  requireSameOrigin(c);
  try {
    const out = await sendInvite(me, c.req.param("id") ?? "", `${new URL(c.req.url).origin}/sign-up`);
    return out.ok ? c.json({ message: out.message }) : c.json({ message: out.message }, out.status);
  } catch (e) {
    console.error("invite email failed", e);
    return c.json({ message: "Couldn't request the invite email. Try again." }, 502);
  }
});
