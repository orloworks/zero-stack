import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bumpVersions, depChanges } from "../../scripts/bump-void";
import { CREATE_VOID } from "../../src/versions";

const src = readFileSync(join(import.meta.dir, "../../src/versions.ts"), "utf8");

test("bumpVersions moves the pin and takes the --admin test packages from void's own ranges", () => {
  const out = bumpVersions(src, CREATE_VOID, "9.9.9", { "better-sqlite3": "^14.0.0", "drizzle-orm": "^0.46.1", vite: "^8.0.0" });
  expect(out).toContain('CREATE_VOID = "9.9.9"');
  expect(out).toContain("same ranges as void@9.9.9");
  expect(out).toContain('export const ADMIN_TEST_DEV_DEPS = { "better-sqlite3": "^14.0.0", "drizzle-orm": "^0.46.1" };');
  expect(out.replace(/CREATE_VOID = "9\.9\.9"|void@9\.9\.9|ADMIN_TEST_DEV_DEPS = \{[^}]*\}/g, "")).toBe(
    src.replace(new RegExp(`CREATE_VOID = "${CREATE_VOID.replaceAll(".", "\\.")}"|void@${CREATE_VOID.replaceAll(".", "\\.")}|ADMIN_TEST_DEV_DEPS = \\{[^}]*\\}`, "g"), ""),
  );
});

test("bumpVersions fails when void drops a package the --admin tests import, or the pin is not where expected", () => {
  expect(() => bumpVersions(src, CREATE_VOID, "9.9.9", { "drizzle-orm": "^0.46.1" })).toThrow(/no longer depends on better-sqlite3/);
  expect(() => bumpVersions(src, "0.0.1", "9.9.9", {})).toThrow(/expected exactly one/);
});

test("depChanges lists moved ranges, better-auth first", () => {
  expect(depChanges({ a: "1", "better-auth": "^1.7.20", z: "1" }, { a: "2", "better-auth": "^1.8.0", z: "1", n: "1" })).toEqual([
    "better-auth: ^1.7.20 -> ^1.8.0",
    "a: 1 -> 2",
    "n: (none) -> 1",
  ]);
});
