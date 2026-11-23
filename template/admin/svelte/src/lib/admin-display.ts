// Pure display helpers for the admin pages (no server imports, so a page component can use them in the browser).
export type Verb = "ban" | "unban" | "revoke-session" | "revoke-sessions" | "delete-user" | "send-link" | "invite" | "revoke-invite" | "send-invite" | "set-feature" | "set-override";

const VERBS: Record<Verb, string> = {
  ban: "banned",
  unban: "unbanned",
  "revoke-session": "revoked a session of",
  "revoke-sessions": "revoked all sessions of",
  "delete-user": "deleted",
  "send-link": "requested a link for",
  invite: "invited",
  "revoke-invite": "removed the invite for",
  "send-invite": "requested an invite email for",
  "set-feature": "set feature",
  "set-override": "set feature",
};

export const SAVED = "Saved. Applies on the user's next page load.";

// "[admin email] [verb] [target]: [old → new]"; the time is rendered by the page.
export function describeAudit(r: { actorEmail: string | null; verb: string; targetEmail: string | null; detail: string | null; oldValue: string | null; newValue: string | null }) {
  const change = r.oldValue && r.newValue ? `: ${r.oldValue} → ${r.newValue}` : "";
  // A feature switch keeps the feature's name in `detail`; an override also names the user.
  if (r.verb === "set-feature") return `${r.actorEmail ?? "A deleted admin"} ${VERBS["set-feature"]} ${r.detail ?? "a feature"}${change}`;
  if (r.verb === "set-override") return `${r.actorEmail ?? "A deleted admin"} ${VERBS["set-override"]} ${r.detail ?? "a feature"} for ${r.targetEmail ?? "a deleted user"}${change}`;
  const reason = r.verb === "ban" && r.detail ? ` (${r.detail})` : "";
  const target = r.verb === "delete-user" ? "a user" : (r.targetEmail ?? "a deleted user");
  return `${r.actorEmail ?? "A deleted admin"} ${VERBS[r.verb as Verb] ?? r.verb} ${target}${change}${reason}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

export function ago(d: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return day(d);
}

export type StatusInput = {
  banned?: boolean | null;
  banReason?: string | null;
  bannedAt?: Date | null;
  emailVerified: boolean;
  lastSignInAt?: Date | null;
  admin: boolean;
  notInvited?: boolean;
};

// Better Auth stores "No reason" when a ban has none.
const NO_REASON = "No reason";

// The one status function: the word for a phone row and the line for user detail (D4, D5).
export function userStatus(u: StatusInput, now: Date = new Date()): { word: "Banned" | "Unverified" | "Admin" | "Active"; line: string } {
  if (u.banned) {
    const reason = u.banReason && u.banReason !== NO_REASON ? `: ${u.banReason}` : "";
    return { word: "Banned", line: `Banned${u.bannedAt ? ` ${day(u.bannedAt)}` : ""}${reason}` };
  }
  if (!u.emailVerified) return { word: "Unverified", line: u.notInvited ? "Not invited (removed from the list)" : "Email not verified" };
  return { word: u.admin ? "Admin" : "Active", line: u.lastSignInAt ? `Active, last sign-in ${ago(u.lastSignInAt, now)}` : "Active, never signed in" };
}

// "Chrome, Mac": enough to tell a user's devices apart; the raw user agent stays out of the page.
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser}, ${os}` : browser;
}
