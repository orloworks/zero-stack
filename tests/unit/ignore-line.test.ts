import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoreLine } from "../../src/installers/shared";

test("ignoreLine starts a new line after a file without a trailing newline, and never duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignore-line-"));
  writeFileSync(join(dir, ".gitignore"), "node_modules");
  ignoreLine(dir, ".env");
  ignoreLine(dir, ".env");
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
  const fresh = mkdtempSync(join(tmpdir(), "ignore-line-"));
  ignoreLine(fresh, ".env");
  expect(readFileSync(join(fresh, ".gitignore"), "utf8")).toBe(".env\n");
});
