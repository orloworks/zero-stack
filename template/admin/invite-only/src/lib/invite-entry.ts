import { signupAllowed } from "../signup-allowlist";

// What an admin types on the Invites page, checked the same way in the browser (inline) and on the server. No server imports.
export type InviteKind = "email" | "domain";
export const EMAIL_ERROR = "Enter an email like name@example.com.";
export const DOMAIN_ERROR = "Enter a domain like example.com.";

const EMAIL = /^[^\s@,]+@[^\s@,]+$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Returns the entry to store (lower case; a domain gets its @) or an error message. The matcher has the last word, so what is stored is what it can match.
export function parseInvite(kind: InviteKind, raw: string): { entry: string } | { error: string } {
  const v = raw.trim().toLowerCase();
  if (kind === "domain") {
    const d = v.startsWith("@") ? v.slice(1) : v;
    return d.length <= 253 && DOMAIN.test(d) && signupAllowed(`@${d}`, `a@${d}`) ? { entry: `@${d}` } : { error: DOMAIN_ERROR };
  }
  return v.length <= 254 && EMAIL.test(v) && signupAllowed(v, v) ? { entry: v } : { error: EMAIL_ERROR };
}

export const previewDomain = (entry: string) => `Anyone at ${entry} can sign up`;
