import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./flags";

const OPEN = "<!-- zero-stack:routing -->";
const CLOSE = "<!-- /zero-stack:routing -->";
const ROUTING = join(import.meta.dir, "../docs/cloudflare-routing.md");

// Appends the routing block to AGENTS.md, replacing it in place on re-run; touches nothing else.
export function writeAgentFiles(targetDir: string, config?: Config): void {
  const agents = join(targetDir, "AGENTS.md");
  if (!existsSync(agents)) throw new Error(`AGENTS.md missing in ${targetDir}`);
  const account = config?.auth && config.framework === "svelte"
    ? `\n\n## Account page\n\nThe Account page is \`/settings\` (\`pages/settings.svelte\`, user from \`pages/settings.server.ts\`). Link it from your nav; it has no home-page link.`
    : "";
  const deletion = config?.accountDeletion
    ? `\n\nThe Account page deletes the account with the user's current password (Better Auth \`deleteUser\`, enabled in \`auth.ts\`). The server always requires the current password: a \`before\` hook in \`auth.ts\` rejects \`/delete-user\` without one, because Better Auth skips the password for fresh sessions. Every table you add that holds user-owned rows must reference \`user.id\` with \`onDelete: "cascade"\` (for example \`.references(() => user.id, { onDelete: "cascade" })\`) so deleting the account removes its data; a row without the cascade is left orphaned or blocks the deletion. Known limit: a social-only account has no password, so it cannot delete itself from this page (Better Auth answers CREDENTIAL_ACCOUNT_NOT_FOUND).`
    : "";
  const email = config?.email
    ? `\n\n## Email\n\nPassword reset and sign-up verification mail go through \`send()\` in \`src/mail.ts\` (wired in \`auth.ts\`; Void \`sendEmail\`); locally they land in the dev inbox at \`/__void/inbox\` (token in \`.void/dev-trigger-token\`, sent as the \`x-void-dev-trigger\` header). Set \`email.from\` in \`void.config.ts\` (scaffolded as \`noreply@example.com\`) to an address on your mail domain. Production delivery needs a mail domain (or Workers Paid on your own Cloudflare account); without one the send fails, is logged, and the user never gets the mail. Verification mail is sent on sign-up but not required to sign in.`
    : "";
  const turnstile = config?.turnstile
    ? `\n\n## Turnstile\n\nSign-up, sign-in and password-reset requests need a Turnstile token (Better Auth \`captcha\` plugin in \`auth.ts\`; widget helper \`src/lib/turnstile.ts\`). Local dev uses Cloudflare's always-pass test keys. Before deploy set both real keys: \`void secret put TURNSTILE_SECRET_KEY\`, and \`VITE_TURNSTILE_SITE_KEY\` in the build shell (\`VITE_TURNSTILE_SITE_KEY=... void deploy\`; builds ignore \`.env\`). The default site key is the test key, and \`auth.ts\` refuses to start with a test secret when \`BETTER_AUTH_URL\` is not localhost.`
    : "";
  const storage = config?.storage
    ? `\n\n## Storage\n\nFiles live in R2 through \`void/storage\`. \`src/storage.ts\` builds per-user keys (\`users/<id>/<name>\`, rejecting names that could leave the prefix) and purges a user's files." \`routes/api/files/[name].ts\` has PUT (streamed upload, needs Content-Length), GET and DELETE for the signed-in user's own files; every handler calls \`requireAuth\`. Keep user data under \`users/<id>/\` so account deletion can purge it."${config.accountDeletion ? " Deleting an account first deletes its files (\`beforeDelete\` in \`auth.ts\`; any storage error aborts the deletion) and sweeps again after." : ""}`
    : "";
  const secrets = config?.secrets
    ? `\n\n## Secrets\n\nSecrets live in Infisical; \`.env\` is a local copy (gitignored, mode 0600). Link this folder first: run the \`secret-sync\` skill, or \`infisical init --project-id <id>\`, which writes \`.infisical.yaml\` (legacy \`.infisical.json\` also works). Then \`bun run secrets:pull\` replaces \`.env\` with the Infisical \`dev\` environment, verbatim (no \`\${VAR}\` expansion). It refuses, leaving \`.env\` untouched and no temp file behind, when the folder has no link file, when Infisical exits non-zero, or when the export lacks any key the current \`.env\` has (it names the missing keys). Infisical's own output is never printed; a failure shows only the exit code and the command to rerun by hand.`
    : "";
  const block = `${OPEN}\n${readFileSync(ROUTING, "utf8").trimEnd()}${account}${deletion}${email}${turnstile}${storage}${secrets}\n${CLOSE}`;
  const text = readFileSync(agents, "utf8");
  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE);
  writeFileSync(
    agents,
    start >= 0 && end > start
      ? text.slice(0, start) + block + text.slice(end + CLOSE.length)
      : text.trimEnd() + "\n\n" + block + "\n",
  );
  writeFileSync(
    join(targetDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" } } }, null, 2) + "\n",
  );
}
