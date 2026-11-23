import { expect, it, vi } from "vite-plus/test";

// Tests run in Node without Worker bindings: the secret is a stand-in, and the database lookup is injected.
vi.mock("void/env", () => ({ env: { SIGNUP_ALLOWLIST: "listed@example.com, @team.test" } }));
vi.mock("void/auth", () => ({ requireAuth: () => null }));

const { coveredBySecret, EXISTING_ACCOUNTS, INVITE_EMAIL_REQUESTED, INVITE_REMOVED, INVITED_DOMAIN, INVITED_EMAIL, inviteAllowed: allowed, secretEntries, STILL_INVITED } = await import("../src/invites");
const { parseInvite } = await import("../src/lib/invite-entry");

const LIST = "listed@example.com, @team.test";
const inviteAllowed = (email: string, load: (c: string[]) => Promise<string[]>) => allowed(email, LIST, load);

// A stand-in for the invite table: it returns the stored entries among the candidates it is asked about, like the real query.
const table = (...entries: string[]) => async (candidates: string[]) => entries.filter((e) => candidates.includes(e));

it("an address on the env list is allowed without asking the database", async () => {
  const load = vi.fn(table());
  expect(await inviteAllowed("Listed@Example.com", load)).toBe(true);
  expect(await inviteAllowed("anyone@team.test", load)).toBe(true);
  expect(load).not.toHaveBeenCalled();
});

it("a database invite admits its exact address (any case) and a database domain admits everyone at it", async () => {
  expect(await inviteAllowed("Beta@Tester.test", table("beta@tester.test"))).toBe(true);
  expect(await inviteAllowed("anyone@corp.test", table("@corp.test"))).toBe(true);
  expect(await inviteAllowed("ANYONE@CORP.TEST", table("@corp.test"))).toBe(true);
});

it("a lookalike is refused: another address, a subdomain, a longer domain, two @, a non-ASCII address", async () => {
  const rows = table("beta@tester.test", "@corp.test");
  for (const email of ["other@tester.test", "beta@sub.tester.test", "x@sub.corp.test", "x@evilcorp.test", "x@corp.test.evil.test", "a@b@corp.test", "x@сorp.test", "beta@tester.test\u0000", ""]) expect([email, await inviteAllowed(email, rows)]).toEqual([email, false]);
});

it("an address in neither source is refused, including with both sources empty", async () => {
  expect(await inviteAllowed("nobody@example.com", table("beta@tester.test"))).toBe(false);
  expect(await inviteAllowed("nobody@example.com", table())).toBe(false);
});

it("the secret's entries are listed lower case and de-duplicated, and a database entry says whether the secret covers it", () => {
  expect(secretEntries("A@x.com, @Y.com  a@x.com\n,")).toEqual(["a@x.com", "@y.com"]);
  expect(secretEntries(undefined)).toEqual([]);
  expect(secretEntries("")).toEqual([]);
  expect(coveredBySecret("listed@example.com", LIST)).toBe(true);
  expect(coveredBySecret("someone@team.test", LIST)).toBe(true);
  expect(coveredBySecret("@team.test", LIST)).toBe(true);
  expect(coveredBySecret("@other.test", LIST)).toBe(false);
  expect(coveredBySecret("someone@other.test", LIST)).toBe(false);
});

it("what an admin types becomes one lower-case entry, or an inline error", () => {
  expect(parseInvite("email", "  Beta@Tester.TEST ")).toEqual({ entry: "beta@tester.test" });
  expect(parseInvite("domain", "Corp.Test")).toEqual({ entry: "@corp.test" });
  expect(parseInvite("domain", "@corp.test")).toEqual({ entry: "@corp.test" });
  for (const bad of ["", "nobody", "a@", "@x.com", "a@b@x.com", "a b@x.com", "a,b@x.com", "a@x.com, b@x.com", "ünï@x.com"]) expect([bad, parseInvite("email", bad)]).toEqual([bad, { error: "Enter an email like name@example.com." }]);
  for (const bad of ["", "localhost", "a@x.com", "x..com", "-x.com", "x.com/path", "x.com, y.com", "exаmple.com", "x.c om"]) expect([bad, parseInvite("domain", bad)]).toEqual([bad, { error: "Enter a domain like example.com." }]);
});

it("the D6 copy is exact", () => {
  expect(INVITED_EMAIL("x@y.com")).toBe("Invited x@y.com.");
  expect(INVITED_DOMAIN("@x.com")).toBe("Invited anyone at @x.com.");
  expect(INVITE_REMOVED).toBe("Invite removed.");
  expect(INVITE_EMAIL_REQUESTED("x@y.com")).toBe("Invite email requested for x@y.com.");
  expect(STILL_INVITED).toBe("Still invited through SIGNUP_ALLOWLIST.");
  expect(EXISTING_ACCOUNTS).toBe("Existing accounts are not affected. Ban the user to block them.");
});
