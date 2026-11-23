// Pure parse, validate and display for typed settings (no server imports, so the Settings page can use it in the browser).
export type SettingDecl =
  | { type: "text"; default: string; description: string }
  | { type: "number"; default: number; min?: number; max?: number; description: string }
  | { type: "boolean"; default: boolean; description: string }
  | { type: "choice"; values: readonly string[]; default: string; description: string };

export type SettingValue = string | number | boolean;
export type Parsed = { ok: true; value: SettingValue } | { ok: false; message: string };

export const MAX_TEXT = 1000;
const fail = (message: string): Parsed => ({ ok: false, message });

// `raw` is a request value or the stored text: numbers and on/off accept their text form, so one function reads both.
export function parseSetting(d: SettingDecl, raw: unknown): Parsed {
  switch (d.type) {
    case "text":
      if (typeof raw !== "string") return fail("Enter text.");
      return raw.length > MAX_TEXT ? fail(`Enter at most ${MAX_TEXT} characters.`) : { ok: true, value: raw };
    case "boolean":
      if (raw === true || raw === "true") return { ok: true, value: true };
      if (raw === false || raw === "false") return { ok: true, value: false };
      return fail("Choose on or off.");
    case "choice":
      return typeof raw === "string" && d.values.includes(raw) ? { ok: true, value: raw } : fail(`Choose one of: ${d.values.join(", ")}.`);
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : Number.NaN; // plain decimals only: no 0x10, 1e3 or Infinity
      if (!Number.isFinite(n)) return fail("Enter a number.");
      const { min, max } = d;
      if (min !== undefined && max !== undefined && (n < min || n > max)) return fail(`Enter a number from ${min} to ${max}.`);
      if (min !== undefined && n < min) return fail(`Enter a number of at least ${min}.`);
      if (max !== undefined && n > max) return fail(`Enter a number of at most ${max}.`);
      return { ok: true, value: n };
    }
  }
}

// What a stored text means: the stored value, or the declared default when nothing is stored or the stored text no longer fits its declaration.
export function resolveSetting(d: SettingDecl, stored: string | undefined): { value: SettingValue; invalid: boolean } {
  if (stored === undefined) return { value: d.default, invalid: false };
  const p = parseSetting(d, stored);
  return p.ok ? { value: p.value, invalid: false } : { value: d.default, invalid: true };
}

export const storedForm = (v: SettingValue): string => String(v);

// "Default: X" on the page.
export const showValue = (v: SettingValue): string => (typeof v === "boolean" ? (v ? "On" : "Off") : v === "" ? "(empty)" : String(v));
