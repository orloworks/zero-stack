import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import { MAIL_TS } from "./auth-ts";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth/email");
const PAGE = "pages/sign-in.svelte";

// --email on svelte: the forgot/reset pages, the generated harness test, and the sign-in edits at the markers installAuth's page leaves.
// The mail callbacks themselves live in composeAuthTs.
export function installEmail(dir: string): void {
  cpSync(join(here, "svelte/pages"), join(dir, "pages"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/mail.ts"), MAIL_TS);
  cpSync(join(here, "tests"), join(dir, "tests"), { recursive: true });
  // Local sends need a sender (the dev inbox has no project slug to default from); replace it with an address on your mail domain.
  const auth = '  "auth": { "providers": ["email"] },';
  editFile(dir, "void.config.ts", (s) => replaceAnchor(s, auth, `${auth}\n  "email": { "from": "noreply@example.com" },`, "void.config.ts"));
  editFile(dir, PAGE, (s) => {
    s = replaceAnchor(s, '  import { auth } from "void/client";\n', '  import { onMount } from "svelte";\n  import { auth } from "void/client";\n', PAGE);
    s = replaceAnchor(s, "  let alertEl: HTMLElement | undefined = $state();\n", `  let alertEl: HTMLElement | undefined = $state();
  let reset = $state(false);
  onMount(() => (reset = new URLSearchParams(location.search).get("reset") === "1"));
`, PAGE);
    s = replaceAnchor(s, "  <!-- zero-stack:sign-in-notice -->\n", '  {#if reset}<p role="status">Password updated. Sign in with your new password.</p>{/if}\n', PAGE);
    return replaceAnchor(s, "    <!-- zero-stack:sign-in-forgot-link -->\n", '    <a href="/forgot-password">Forgot password?</a>\n', PAGE);
  });
}
