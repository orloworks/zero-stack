import { defineHandler } from "void";
import { adminSwitches } from "../../../../../../src/access";
import { requireAdmin, requireSameOrigin } from "../../../../../../src/admin";
import { SAVED } from "../../../../../../src/lib/admin-display";

// Sets one user's override of a feature: { state: "default" | "on" | "off" }. The change and its audit entry are written in one batch, so it is never unaudited.
export const POST = defineHandler(async (c) => {
  requireAdmin(c);
  requireSameOrigin(c);
  const body = (await c.req.json().catch(() => null)) as { state?: unknown } | null;
  const out = await (await adminSwitches(c)).set({ feature: c.req.param("feature") ?? "", userId: c.req.param("id") ?? "", state: body?.state });
  return out.ok ? c.json({ message: SAVED }) : c.json({ message: out.message }, out.status);
});
