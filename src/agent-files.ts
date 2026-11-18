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
    ? `\n\nThe Account page deletes the account with the user's current password (Better Auth \`deleteUser\`, enabled in \`auth.ts\`). Every table you add that holds user-owned rows must reference \`user.id\` with \`onDelete: "cascade"\` (for example \`.references(() => user.id, { onDelete: "cascade" })\`) so deleting the account removes its data; a row without the cascade is left orphaned or blocks the deletion. Known limit: a social-only account has no password, so it cannot delete itself from this page (Better Auth answers CREDENTIAL_ACCOUNT_NOT_FOUND).`
    : "";
  const block = `${OPEN}\n${readFileSync(ROUTING, "utf8").trimEnd()}${account}${deletion}\n${CLOSE}`;
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
