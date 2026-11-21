// SIGNUP_ALLOWLIST: exact emails (a@x.com) and whole domains (@x.com), separated by commas or whitespace, case-insensitive.
// Fails closed: a missing, empty or non-string list allows no one (`list` is unknown because auth.ts reads it from an untyped env).
export function signupAllowed(list: unknown, email: string): boolean {
  const addr = email.trim().toLowerCase();
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  return (typeof list === "string" ? list : "")
    .toLowerCase()
    .split(/[\s,]+/)
    .some((e) => (e.startsWith("@") ? e.length > 1 && addr.includes("@") && domain === e.slice(1) : e !== "" && e === addr));
}
