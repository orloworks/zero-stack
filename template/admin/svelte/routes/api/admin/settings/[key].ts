import { defineHandler } from "void";
import { requireAdmin, requireSameOrigin } from "../../../../src/admin";
import { SAVED } from "../../../../src/lib/admin-display";
import { adminSettings } from "../../../../src/settings";

// POST saves a setting: { value }, parsed and validated against its declaration. DELETE resets it to the default. The change and its audit entry are written in one batch.
export const POST = defineHandler(async (c) => {
  requireAdmin(c);
  requireSameOrigin(c);
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  const out = await adminSettings(c).set(c.req.param("key") ?? "", body?.value);
  return out.ok ? c.json({ message: SAVED }) : c.json({ message: out.message }, out.status);
});

export const DELETE = defineHandler(async (c) => {
  requireAdmin(c);
  requireSameOrigin(c);
  const out = await adminSettings(c).reset(c.req.param("key") ?? "");
  return out.ok ? c.json({ message: SAVED }) : c.json({ message: out.message }, out.status);
});
