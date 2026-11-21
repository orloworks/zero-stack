import { expect, it } from "vite-plus/test";
import { signupAllowed } from "../src/signup-allowlist";

it("matches an exact email, ignoring case and surrounding whitespace", () => {
  expect(signupAllowed("alice@x.com", "alice@x.com")).toBe(true);
  expect(signupAllowed("  Alice@X.com ", " ALICE@x.COM ")).toBe(true);
  expect(signupAllowed("alice@x.com", "bob@x.com")).toBe(false);
});

it("separates entries on commas and on any whitespace", () => {
  const list = "a@x.com,b@x.com\nc@x.com  d@x.com,\te@x.com";
  for (const e of ["a", "b", "c", "d", "e"]) expect(signupAllowed(list, `${e}@x.com`)).toBe(true);
  expect(signupAllowed(list, "f@x.com")).toBe(false);
});

it("a domain entry matches exactly that domain", () => {
  expect(signupAllowed("@x.com", "anyone@x.com")).toBe(true);
  expect(signupAllowed("@X.com", "anyone@x.COM")).toBe(true);
  for (const e of ["a@sub.x.com", "a@evilx.com", "a@x.com.evil.com", "x.com", "a@"]) expect(signupAllowed("@x.com", e)).toBe(false);
});

it("an entry without @ is an exact email, never a domain", () => {
  expect(signupAllowed("x.com", "a@x.com")).toBe(false);
  expect(signupAllowed("x.com", "x.com")).toBe(true); // not an email Better Auth would accept; still no domain match
  expect(signupAllowed("@", "a@")).toBe(false);
});

it("an empty, blank or missing list refuses everyone", () => {
  for (const list of ["", "  \n ,, ", undefined]) {
    expect(signupAllowed(list, "a@x.com")).toBe(false);
    expect(signupAllowed(list, "")).toBe(false);
  }
});
