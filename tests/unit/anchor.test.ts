import { expect, test } from "bun:test";
import { replaceAnchor } from "../../src/anchor";

test("replaces a single anchor, keeping `$` in the replacement literal", () => {
  expect(replaceAnchor("a X b", "X", "$&1", "f")).toBe("a $&1 b");
});

test("a missing anchor fails naming the anchor and the pinned version", () => {
  expect(() => replaceAnchor("abc", "X", "y", "f.ts")).toThrow(/"X" not found in f\.ts \(create-void@1\.8\.0\)/);
});

test("a duplicated anchor fails naming the anchor and the pinned version", () => {
  expect(() => replaceAnchor("X X", "X", "y", "f.ts")).toThrow(/"X" found 2 times in f\.ts \(create-void@1\.8\.0\)/);
});
