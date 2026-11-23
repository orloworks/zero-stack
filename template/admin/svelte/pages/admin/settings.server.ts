import { defineHandler, type InferProps } from "void";
import { requireAdmin } from "../../src/admin";
import { showValue } from "../../src/lib/setting-value";
import { adminSettings } from "../../src/settings";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  requireAdmin(c);
  try {
    const rows = await adminSettings(c).list();
    return {
      settings: rows.map(({ key, decl, value, invalid, hasRow }) => ({
        key,
        type: decl.type,
        description: decl.description,
        value,
        defaultText: showValue(decl.default),
        defaultValue: decl.default,
        // Reset is offered once a stored value differs from the default or no longer fits.
        canReset: hasRow && (invalid || value !== decl.default),
        invalid,
        min: decl.type === "number" ? (decl.min ?? null) : null,
        max: decl.type === "number" ? (decl.max ?? null) : null,
        values: decl.type === "choice" ? [...decl.values] : [],
      })),
      loadError: false,
    };
  } catch (e) {
    console.error("admin settings load failed", e);
    return { settings: [], loadError: true };
  }
});
