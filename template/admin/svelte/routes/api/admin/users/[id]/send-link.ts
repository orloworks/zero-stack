import { defineHandler } from "void";
import { getAuth } from "void/auth";
import { findUser, notFound, recordAudit, requireAdmin, requireSameOrigin, setPasswordLink } from "../../../../../src/admin";

// Sends the user a reset link (an unverified user in an invite-only app gets a set-password link). It runs on the server, so Better Auth's captcha, which
// guards the browser route, is not in the way of an admin's own action. It answers "requested", never "sent": Better Auth answers 200 even when the mail fails.
export const POST = defineHandler(async (c) => {
  const me = requireAdmin(c);
  requireSameOrigin(c);
  const target = await findUser(c.req.param("id") ?? "");
  if (!target) throw notFound();
  await getAuth(c).api.requestPasswordReset({ body: { email: target.email, redirectTo: "/reset-password" } });
  const kind = setPasswordLink(target) ? "set-password" : "reset";
  try {
    await recordAudit({ actor: me, verb: "send-link", target, detail: kind });
  } catch (e) {
    console.error("audit write failed (send-link)", e);
    return c.json({ code: "AUDIT_WRITE_FAILED", message: "The link was requested but the change could not be recorded in the audit log." }, 500);
  }
  return c.json({ kind });
});
