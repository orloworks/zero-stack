import { cpSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import { addPaths, ignoreLine } from "./shared";
import type { Config } from "../flags";
import { composeAuthTs } from "./auth-ts";
import { composeEnvTs } from "./env-ts";
import { installAccountDeletion } from "./account-deletion";
import { installEmail } from "./email";
import { installTurnstile } from "./turnstile";
import { installInviteOnly } from "./invite-only";

export const authEnv = (config: Pick<Config, "turnstile" | "inviteOnly" | "admin" | "payments">): string =>
  `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\nBETTER_AUTH_URL=http://localhost:5173\n${config.turnstile ? "TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\n" : ""}${config.inviteOnly ? "SIGNUP_ALLOWLIST=@example.com\n" : ""}${config.admin ? "ADMIN_EMAILS=@example.com\n" : ""}${config.payments ? "STRIPE_SECRET_KEY=sk_test_placeholder\nSTRIPE_WEBHOOK_SECRET=whsec_placeholder\n" : ""}`;

// Runs after installShadcn. Pages are copied; `void db generate` runs later in the pipeline (needs deps).
export function installAuth(dir: string, config: Config): void {
  const framework = config.framework;
  const slice = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth", framework);
  editFile(dir, "void.config.ts", (s) =>
    replaceAnchor(s, "export default defineConfig({", 'export default defineConfig({\n  "auth": { "providers": ["email"] },', "void.config.ts"),
  );

  addPaths(dir, { "@auth-schema": ["./.void/better-auth-schema.ts"] });

  writeFileSync(join(dir, "auth.ts"), composeAuthTs(config));
  if (framework === "svelte") {
    const envTs = composeEnvTs(config);
    if (envTs) writeFileSync(join(dir, "env.ts"), envTs);
  }

  cpSync(join(slice, "pages"), join(dir, "pages"), { recursive: true });
  if (config.accountDeletion) installAccountDeletion(dir, config);
  if (config.email) installEmail(dir);
  if (config.turnstile) installTurnstile(dir, config);
  if (config.inviteOnly) installInviteOnly(dir);

  ignoreLine(dir, ".env");
  writeFileSync(join(dir, ".env"), authEnv(config), { mode: 0o600 });
}
