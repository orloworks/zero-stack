// SIGNUP_ALLOWLIST: exact emails (a@x.com) and whole domains (@x.com), separated by commas or whitespace, case-insensitive.
// An email without exactly one @, or with any non-ASCII character, is refused. Fails closed: a missing, empty or non-string list allows no one (`list` is unknown because auth.ts reads it from an untyped env).
export function signupAllowed(list: unknown, email: string): boolean {
  const addr = email.trim().toLowerCase();
  if (addr.split("@").length !== 2 || !/^[ -~]*$/.test(addr)) return false; // exactly one @, printable ASCII only: no lookalikes or odd parses
  const domain = addr.slice(addr.indexOf("@") + 1);
  return (typeof list === "string" ? list : "")
    .toLowerCase()
    .split(/[\s,]+/)
    .some((e) => (e.startsWith("@") ? e.length > 1 && domain === e.slice(1) : e !== "" && e === addr));
}
