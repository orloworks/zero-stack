// SIGNUP_ALLOWLIST: exact emails (a@x.com) and whole domains (@x.com), separated by commas or whitespace, case-insensitive.
// An email without exactly one @, with an empty local part, or with any non-ASCII character in the raw input, is refused. Fails closed: a missing, empty or non-string list allows no one (`list` is unknown because auth.ts reads it from an untyped env).
export function signupAllowed(list: unknown, email: string): boolean {
  if (!/^[ -~]*$/.test(email)) return false; // ASCII on the raw input: trim() and toLowerCase() would otherwise turn a BOM, an ideographic space or a Kelvin sign into a match
  const addr = email.trim().toLowerCase();
  if (addr.split("@").length !== 2 || addr.startsWith("@")) return false; // exactly one @ and a local part
  const domain = addr.slice(addr.indexOf("@") + 1);
  return (typeof list === "string" ? list : "")
    .toLowerCase()
    .split(/[\s,]+/)
    .some((e) => (e.startsWith("@") ? e.length > 1 && domain === e.slice(1) : e !== "" && e === addr));
}
