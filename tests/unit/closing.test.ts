import { expect, test } from "bun:test";
import { closingLines } from "../../src/closing";
import { validateFlags } from "../../src/flags";

const lines = (o: object) => closingLines(validateFlags({ name: "x", framework: "svelte", ...o }).config);

test("--admin closes with the first step; without it the line is absent", () => {
  expect(lines({ admin: true })).toEqual(["Account page: /settings (link it from your nav).", "To use /admin, sign in with an email on ADMIN_EMAILS and verify it."]);
  expect(lines({ auth: true })).toEqual(["Account page: /settings (link it from your nav)."]);
  expect(lines({})).toEqual([]);
  expect(closingLines(validateFlags({ name: "x", framework: "react", auth: true }).config)).toEqual([]);
});
