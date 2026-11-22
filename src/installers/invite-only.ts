import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth/invite-only");
const EMAIL_TEST = "tests/auth-email.test.ts";
const PAGE = "pages/sign-up.svelte";
const NOTICE = "Check your inbox to finish signing up.";
const SIGN_IN = "pages/sign-in.svelte";
// One message for "not verified yet" and "wrong password", so sign-in can't tell a probe who is on the list (an uninvited address has no user row, so it can only ever say wrong password).
const SIGN_IN_MESSAGE = "Wrong email or password, or the email isn't verified yet. If you just signed up, check your inbox for the link.";
const DEFINE = "define({ defaults: { emailAndPassword: { enabled: true } }, env: {} });";

// --invite-only on svelte: the matcher and its test, and the sign-up page's notice. The check itself is a part of the composed auth.ts, the key a part of env.ts.
// Sign-up needs a verified email, so it never signs in: the page shows one notice after an invited sign-up and after a refused one (Better Auth answers the
// refused one with a 200 and a placeholder user; a 403 SIGNUP_INVITE_ONLY, from any other route to the hook, is shown the same), so it never reveals who is on the list.
// The email add-on's test signs a user up through the real hook, so it gets an allowlist (an empty one would refuse the sign-up).
export function installInviteOnly(dir: string): void {
  cpSync(here, dir, { recursive: true, force: false, errorOnExist: true });
  editFile(dir, PAGE, (s) => {
    s = replaceAnchor(s, '  let error = $state("");\n', '  let error = $state("");\n  let sent = $state(false);\n', PAGE);
    s = replaceAnchor(
      s,
      '      if (res.error) (error = res.error.message ?? "Sign up failed"), (invalid = true);\n      else {\n        location.href = "/";\n        return;\n      }\n',
      '      if (res.error && res.error.code !== "SIGNUP_INVITE_ONLY") (error = res.error.message ?? "Sign up failed"), (invalid = true);\n      else sent = true;\n',
      PAGE,
    );
    s = replaceAnchor(s, "  <form onsubmit={submit}>\n", `  {#if sent}\n    <p role="status">${NOTICE}</p>\n  {:else}\n  <form onsubmit={submit}>\n`, PAGE);
    return replaceAnchor(s, "  </form>\n", "  </form>\n  {/if}\n", PAGE);
  });
  editFile(dir, SIGN_IN, (s) =>
    replaceAnchor(
      s,
      '      if (res.error) (error = res.error.message ?? "Sign in failed"), (invalid = true);\n',
      `      if (res.error)\n        (error = res.error.code === "EMAIL_NOT_VERIFIED" || res.error.code === "INVALID_EMAIL_OR_PASSWORD" ? "${SIGN_IN_MESSAGE}" : (res.error.message ?? "Sign in failed")), (invalid = true);\n`,
      SIGN_IN,
    ),
  );
  // --invite-only implies --email (validateFlags), so the email add-on's test is always there.
  editFile(dir, EMAIL_TEST, (s) => {
    for (const decl of ["const { emailAndPassword } = ", "const options = "])
      s = replaceAnchor(s, decl + DEFINE, decl + DEFINE.replace("env: {}", 'env: { SIGNUP_ALLOWLIST: "@example.com" }'), EMAIL_TEST);
    return s;
  });
}
