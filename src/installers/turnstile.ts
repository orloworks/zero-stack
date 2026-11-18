import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import type { Config } from "../flags";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth/turnstile");
const MARK = "<!-- zero-stack:turnstile -->\n";
const IMPORT = '  import { auth } from "void/client";\n';
const STATE = "  let alertEl: HTMLElement | undefined = $state();\n";
const TAIL = "    }\n    pending = false;\n";

// --turnstile on svelte: env.ts, the helper, the startup guard and their tests, plus the widget at each page's marker.
// Runs after installEmail, which also edits sign-in's import and state lines (both anchors stay unique).
export function installTurnstile(dir: string, config: Config): void {
  cpSync(here, dir, { recursive: true });
  const pages: [string, string, string][] = [
    ["pages/sign-in.svelte", "auth.signIn.email({ email, password })", "auth.signIn.email({ email, password }, captcha())"],
    ["pages/sign-up.svelte", "auth.signUp.email({ name, email, password })", "auth.signUp.email({ name, email, password }, captcha())"],
    ...(config.email
      ? [["pages/forgot-password.svelte", 'auth.requestPasswordReset({ email, redirectTo: "/reset-password" })', 'auth.requestPasswordReset({ email, redirectTo: "/reset-password" }, captcha())'] as [string, string, string]]
      : []),
  ];
  for (const [page, call, withCaptcha] of pages)
    editFile(dir, page, (s) => {
      s = replaceAnchor(s, IMPORT, `${IMPORT}  import { mountTurnstile, type Turnstile } from "../src/lib/turnstile";\n`, page);
      s = replaceAnchor(s, STATE, `${STATE}  let token = $state<string | null>(null);
  let checkFailed = $state(false);
  let turnstileEl: HTMLElement | undefined = $state();
  let turnstile: Turnstile | undefined;
  $effect(() => {
    if (!turnstileEl) return;
    const t = (turnstile = mountTurnstile(turnstileEl, { onToken: (v) => (token = v), onError: () => (checkFailed = true) }));
    return () => t.dispose();
  });
  const captcha = () => ({ headers: { "x-captcha-response": turnstile?.token() ?? "" } });
`, page);
      s = replaceAnchor(s, call, withCaptcha, page);
      s = replaceAnchor(s, TAIL, "    } finally {\n      turnstile?.reset();\n    }\n    pending = false;\n", page);
      s = replaceAnchor(s, "disabled={pending}", "disabled={pending || !token}", page);
      return replaceAnchor(s, MARK, `<div bind:this={turnstileEl}></div>
    {#if checkFailed}<p role="alert">Couldn't load the verification check. Reload the page to try again.</p>{:else if !token}<p role="status">Completing a quick check…</p>{/if}
`, page);
    });
}
