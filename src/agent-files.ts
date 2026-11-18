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
  const block = `${OPEN}\n${readFileSync(ROUTING, "utf8").trimEnd()}${account}\n${CLOSE}`;
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
