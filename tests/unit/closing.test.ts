import { expect, test } from "bun:test";
import { closingLines } from "../../src/closing";
import { validateFlags } from "../../src/flags";

const lines = (o: object) => closingLines(validateFlags({ name: "x", framework: "svelte", ...o }).config);

test("--admin closes with the first step; without it the line is absent", () => {
  expect(lines({ admin: true })).toEqual([
    "Account page: /settings (link it from your nav).",
    "To use /admin, sign up with an email on ADMIN_EMAILS, open the verification link, then set your password from the link that follows.",
  ]);
  expect(lines({ admin: true, inviteOnly: true }).at(-1)).toBe("To use /admin, sign up with an email on ADMIN_EMAILS and set your password from the link mailed to it.");
  expect(lines({ auth: true })).toEqual(["Account page: /settings (link it from your nav)."]);
  expect(lines({})).toEqual([]);
  expect(closingLines(validateFlags({ name: "x", framework: "react", auth: true }).config)).toEqual([]);
});
