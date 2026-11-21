import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import type { Config } from "../flags";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth/invite-only");
const EMAIL_TEST = "tests/auth-email.test.ts";
const DEFINE = "define({ defaults: { emailAndPassword: { enabled: true } }, env: {} });";

// --invite-only on svelte: the matcher and its test. The check itself is a part of the composed auth.ts, the key a part of env.ts.
// The email add-on's test signs a user up through the real hook, so it gets an allowlist (an empty one would refuse the sign-up).
export function installInviteOnly(dir: string, config: Config): void {
  cpSync(here, dir, { recursive: true, force: false, errorOnExist: true });
  if (config.email)
    editFile(dir, EMAIL_TEST, (s) => {
      for (const decl of ["const { emailAndPassword } = ", "const options = "])
        s = replaceAnchor(s, decl + DEFINE, decl + DEFINE.replace("env: {}", 'env: { SIGNUP_ALLOWLIST: "@example.com" }'), EMAIL_TEST);
      return s;
    });
}
