import { defineHandler } from "void";
import { requireAdmin, requireSameOrigin } from "../../../../../src/admin";
import { revokeInvite } from "../../../../../src/invites";

// Removes an invite. Existing accounts are never touched; the notes say whether the secret still invites the address.
export const POST = defineHandler(async (c) => {
  const me = requireAdmin(c);
  requireSameOrigin(c);
  const out = await revokeInvite(me, c.req.param("id") ?? "");
  return out.ok ? c.json({ message: out.message, notes: out.notes }) : c.json({ message: out.message }, out.status);
});
