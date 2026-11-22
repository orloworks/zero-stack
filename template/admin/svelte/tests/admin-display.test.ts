import { expect, it } from "vite-plus/test";
import { ago, day, describeAudit, deviceLabel, userStatus } from "../src/lib/admin-display";

const now = new Date("2026-11-22T12:00:00Z");
const base = { emailVerified: true, admin: false };

it("userStatus gives the one status line and the phone word (D5)", () => {
  expect(userStatus({ ...base, banned: true, banReason: "spam", bannedAt: new Date("2026-11-03T09:00:00Z") }, now)).toEqual({ word: "Banned", line: "Banned 3 Nov: spam" });
  expect(userStatus({ ...base, banned: true, banReason: "No reason", bannedAt: new Date("2026-11-03T09:00:00Z") }, now).line).toBe("Banned 3 Nov");
  expect(userStatus({ ...base, emailVerified: false }, now)).toEqual({ word: "Unverified", line: "Email not verified" });
  expect(userStatus({ ...base, emailVerified: false, notInvited: true }, now).line).toBe("Not invited (removed from the list)");
  expect(userStatus({ ...base, lastSignInAt: new Date("2026-11-22T10:00:00Z") }, now)).toEqual({ word: "Active", line: "Active, last sign-in 2h ago" });
  expect(userStatus({ ...base, admin: true }, now)).toEqual({ word: "Admin", line: "Active, never signed in" });
  // a ban wins over unverified and admin
  expect(userStatus({ ...base, banned: true, emailVerified: false, admin: true }, now).word).toBe("Banned");
});

it("ago is relative up to a month, then the date", () => {
  expect([0, 59, 60, 3599, 3600, 86399, 86400].map((s) => ago(new Date(now.getTime() - s * 1000), now))).toEqual(["just now", "just now", "1m ago", "59m ago", "1h ago", "23h ago", "1d ago"]);
  expect(ago(new Date("2026-09-01T00:00:00Z"), now)).toBe("1 Sep");
  expect(day(new Date("2026-11-03T23:59:00Z"))).toBe("3 Nov");
});

it("deviceLabel names a browser and an OS, never the raw user agent", () => {
  expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36")).toBe("Chrome, Mac");
  expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17 Safari/604")).toBe("Safari, iOS");
  expect(deviceLabel("")).toBe("Unknown device");
  expect(deviceLabel(null)).toBe("Unknown device");
});

it("describeAudit reads '[admin] [verb] [target]: [old → new]' and survives a deleted admin or target", () => {
  const row = { actorEmail: "a@x.com", verb: "ban", targetEmail: "u@x.com", detail: "spam", oldValue: "active", newValue: "banned" };
  expect(describeAudit(row)).toBe("a@x.com banned u@x.com: active → banned (spam)");
  expect(describeAudit({ ...row, actorEmail: null, targetEmail: null, detail: null })).toBe("A deleted admin banned a deleted user: active → banned");
  expect(describeAudit({ ...row, verb: "delete-user", targetEmail: null, detail: "deleted user u1", oldValue: null, newValue: null })).toBe("a@x.com deleted a user");
});
