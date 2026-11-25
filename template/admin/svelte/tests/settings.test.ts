import { expect, it, vi } from "vite-plus/test";
import { parseSetting, resolveSetting, showValue, type SettingDecl } from "../src/lib/setting-value";

// Tests run in Node without Worker bindings: the session, the secret and the database are stand-ins. The database is down, so only paths that decide before reading it are exercised.
const session = vi.hoisted(() => ({ user: { id: "u1", email: "boss@example.com", emailVerified: true } as { id: string; email: string; emailVerified: boolean } | null }));
vi.mock("void/auth", () => ({
  getUser: () => session.user,
  requireAuth: () => session.user,
}));
vi.mock("void/env", () => ({ env: { ADMIN_EMAILS: "boss@example.com" } }));
// The app declares whatever it likes, including nothing: this test brings its own declarations.
vi.mock("../src/app/settings", () => ({
  SETTINGS: { "test-number": { type: "number", default: 10, min: 1, max: 100, description: "A number between 1 and 100." } },
}));
vi.mock("void/db", () => {
  throw new Error("database down");
});

const settings = await import("../src/settings");
const { SETTINGS, adminSettings } = settings;

const text: SettingDecl = { type: "text", default: "hi", description: "d" };
const num: SettingDecl = { type: "number", default: 5, min: 1, max: 10, description: "d" };
const open: SettingDecl = { type: "number", default: 0, description: "d" };
const bool: SettingDecl = { type: "boolean", default: false, description: "d" };
const pick: SettingDecl = { type: "choice", values: ["a", "b"], default: "a", description: "d" };
const value = (d: SettingDecl, raw: unknown) => {
  const p = parseSetting(d, raw);
  return p.ok ? p.value : p.message;
};

it("exports the typed getter, the declarations and the admin editor", () => {
  expect(Object.keys(settings).sort()).toEqual(["SETTINGS", "adminSettings", "setting"]);
});

it("number: plain decimals only, so 0x10, 0b11, 1e3 and Infinity are refused", () => {
  expect(value(open, "42")).toBe(42);
  expect(value(open, " -1.5 ")).toBe(-1.5);
  for (const raw of ["0x10", "0b11", "1e3", "Infinity", "1_000", "+"]) expect([raw, value(open, raw)]).toEqual([raw, "Enter a number."]);
});

it("text: any string up to the limit, nothing else", () => {
  expect(value(text, "hello")).toBe("hello");
  expect(value(text, "")).toBe("");
  expect(value(text, "x".repeat(1001))).toBe("Enter at most 1000 characters.");
  expect(value(text, 5)).toBe("Enter text.");
  expect(value(text, null)).toBe("Enter text.");
});

it("number: bounds are inclusive and the message names them", () => {
  expect(value(num, 1)).toBe(1);
  expect(value(num, 10)).toBe(10);
  expect(value(num, "7.5")).toBe(7.5);
  expect(value(num, 0)).toBe("Enter a number from 1 to 10.");
  expect(value(num, 11)).toBe("Enter a number from 1 to 10.");
  expect(value(open, -3)).toBe(-3);
  expect(value({ ...open, min: 2 } as SettingDecl, 1)).toBe("Enter a number of at least 2.");
  expect(value({ ...open, max: 2 } as SettingDecl, 3)).toBe("Enter a number of at most 2.");
  for (const bad of ["", "  ", "abc", Number.NaN, Infinity, null, undefined, true, []]) expect([bad, value(num, bad)]).toEqual([bad, "Enter a number."]);
});

it("boolean: true or false, in either form", () => {
  expect([value(bool, true), value(bool, "true"), value(bool, false), value(bool, "false")]).toEqual([true, true, false, false]);
  for (const bad of ["yes", 1, 0, null, "on"]) expect([bad, value(bool, bad)]).toEqual([bad, "Choose on or off."]);
});

it("choice: only a declared value", () => {
  expect(value(pick, "b")).toBe("b");
  expect(value(pick, "c")).toBe("Choose one of: a, b.");
  expect(value(pick, 1)).toBe("Choose one of: a, b.");
});

it("a stored value that no longer fits reads as the default and is flagged", () => {
  expect(resolveSetting(num, undefined)).toEqual({ value: 5, invalid: false });
  expect(resolveSetting(num, "8")).toEqual({ value: 8, invalid: false });
  expect(resolveSetting(num, "99")).toEqual({ value: 5, invalid: true }); // out of range
  expect(resolveSetting(num, "abc")).toEqual({ value: 5, invalid: true }); // wrong type
  expect(resolveSetting(pick, "z")).toEqual({ value: "a", invalid: true }); // no longer in the set
  expect(resolveSetting(bool, "true")).toEqual({ value: true, invalid: false });
});

it("shows defaults the way the page says them", () => {
  expect([showValue(true), showValue(false), showValue(""), showValue(10), showValue("x")]).toEqual(["On", "Off", "(empty)", "10", "x"]);
});

it("an undeclared key and an invalid value are refused before anything is read or written", async () => {
  const c = { req: { raw: new Request("http://localhost/") } } as never;
  const admin = adminSettings(c);
  expect(await admin.set("nope", 1)).toMatchObject({ ok: false, status: 400 });
  expect(await admin.set("__proto__", 1)).toMatchObject({ ok: false, status: 400 });
  expect(await admin.set("toString", 1)).toMatchObject({ ok: false, status: 400 });
  expect(await admin.reset("nope")).toMatchObject({ ok: false, status: 400 });
  expect(await admin.set("test-number", 101)).toMatchObject({ ok: false, status: 400, message: "Enter a number from 1 to 100." });
});

it("a number whose stored form would not parse back is refused, not stored as an invalid setting", async () => {
  (SETTINGS as Record<string, SettingDecl>)["test-open-number"] = open; // test-number has bounds that refuse these first
  const admin = adminSettings({} as never);
  for (const n of [1e21, 1e-7]) expect([n, await admin.set("test-open-number", n)]).toEqual([n, { ok: false, status: 400, message: "Enter a number with fewer digits." }]);
});

it("a non-admin gets the 404 before anything else", () => {
  session.user = { id: "u2", email: "other@example.com", emailVerified: true };
  expect(() => adminSettings({ req: { raw: new Request("http://localhost/") } } as never)).toThrow();
  session.user = null;
});
