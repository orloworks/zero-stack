import { expect, it, vi } from "vite-plus/test";

// Tests run in Node without Worker bindings: the session and the secret are stand-ins.
vi.mock("void/auth", () => ({
  requireAuth: (c: { user?: unknown }) => {
    if (!c.user) throw new Error("401");
    return c.user;
  },
}));
vi.mock("void/env", () => ({ env: { ADMIN_EMAILS: "boss@example.com, @team.test" } }));

const { adminAccess, auditRow, isAdmin, notFound, requireAdmin } = await import("../src/admin");

it("an admin is a verified user on the list: an exact email or a whole domain, any case", () => {
  const list = "boss@example.com, @team.test";
  expect(isAdmin(list, { email: "Boss@Example.com", emailVerified: true })).toBe(true);
  expect(isAdmin(list, { email: "anyone@team.test", emailVerified: true })).toBe(true);
  expect(isAdmin(list, { email: "boss@example.com", emailVerified: false })).toBe(false); // unverified: someone who signed up with the owner's address first gets nothing
  for (const email of ["x@sub.team.test", "x@evilteam.test", "other@example.com", "a@b@team.test"]) expect(isAdmin(list, { email, emailVerified: true })).toBe(false);
  expect(isAdmin("", { email: "boss@example.com", emailVerified: true })).toBe(false); // an empty list means no admins
  expect(isAdmin(undefined, { email: "boss@example.com", emailVerified: true })).toBe(false);
  expect(isAdmin(list, null)).toBe(false);
});

it("requireAdmin answers 404 for signed out, signed in and listed-but-unverified alike", () => {
  const status = (user?: object) => {
    try {
      requireAdmin({ user } as never);
    } catch (e) {
      return (e as { status: number }).status;
    }
    return 200;
  };
  expect(status()).toBe(404);
  expect(status({ email: "someone@example.com", emailVerified: true })).toBe(404);
  expect(status({ email: "boss@example.com", emailVerified: false })).toBe(404);
  expect(status({ email: "boss@example.com", emailVerified: true })).toBe(200);
  expect(notFound().status).toBe(404);
});

it("adminAccess tells the Account page who to greet and who to hint (D9)", () => {
  expect(adminAccess({ email: "boss@example.com", emailVerified: true })).toBe("admin");
  expect(adminAccess({ email: "boss@example.com", emailVerified: false })).toBe("unverified");
  expect(adminAccess({ email: "someone@example.com", emailVerified: false })).toBeNull();
  expect(adminAccess({ email: "someone@example.com", emailVerified: true })).toBeNull();
  expect(adminAccess(null)).toBeNull();
});

it("auditRow lower-cases emails, defaults the optional parts to null and leaves a deletion row with no target", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const row = auditRow({ actor: { id: "a1", email: "Boss@Example.com" }, verb: "ban", target: { id: "u1", email: "U@X.com" }, detail: "spam", oldValue: "active", newValue: "banned" }, now);
  expect(row).toMatchObject({ actorUserId: "a1", actorEmail: "boss@example.com", targetUserId: "u1", targetEmail: "u@x.com", verb: "ban", detail: "spam", oldValue: "active", newValue: "banned", createdAt: now });
  expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  const del = auditRow({ actor: { id: "a1", email: "boss@example.com" }, verb: "delete-user", target: null, detail: "deleted user u1" }, now);
  expect(del).toMatchObject({ targetUserId: null, targetEmail: null, detail: "deleted user u1", oldValue: null, newValue: null });
});
