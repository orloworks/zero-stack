import { defineHandler } from "void";
import { requireAdmin, requireSameOrigin } from "../../../src/admin";
import { addInvite } from "../../../src/invites";

// Adds an invite: { kind: "email" | "domain", value }. The invite and its audit entry are written in one batch, so it is never unaudited.
export const POST = defineHandler(async (c) => {
  const me = requireAdmin(c);
  requireSameOrigin(c);
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown; value?: unknown } | null;
  if ((body?.kind !== "email" && body?.kind !== "domain") || typeof body.value !== "string") return c.json({ message: "Choose an exact email or a whole domain, and enter it." }, 400);
  const out = await addInvite(me, body.kind, body.value);
  return out.ok ? c.json({ entry: out.entry, message: out.message }) : c.json({ message: out.message }, out.status);
});
