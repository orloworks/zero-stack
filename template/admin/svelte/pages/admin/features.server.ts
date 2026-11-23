import { defineHandler, type InferProps } from "void";
import { adminSwitches, FEATURES } from "../../src/access";
import { requireAdmin } from "../../src/admin";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  requireAdmin(c);
  try {
    const { global } = await adminSwitches(c);
    return { features: FEATURES.map((name) => ({ name, state: global[name] ?? ("off" as const) })), loadError: false };
  } catch (e) {
    console.error("admin features load failed", e);
    return { features: [], loadError: true };
  }
});
