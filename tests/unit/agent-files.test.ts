import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSkill } from "../../scripts/link-skill";
import { scaffold } from "../../src/pipeline";

const tmp = () => mkdtempSync(join(tmpdir(), "zs-test-"));
const OPEN = "<!-- zero-stack:routing -->";

// Fake create-void: makes the dir with Void's AGENTS.md and a package.json.
const fake = (dir: string) => async (cmd: string[]) => {
  if (cmd.includes("create-void@1.8.0")) {
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { postinstall: "void prepare" } }));
    writeFileSync(join(dir, "AGENTS.md"), "# Void\nvoid section\n<!--/injected-by-void-->\n");
  }
};

test("scaffold appends one routing block to AGENTS.md and writes .mcp.json", async () => {
  const dir = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, dir, fake(dir));
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(agents.startsWith("# Void\nvoid section\n<!--/injected-by-void-->\n")).toBe(true);
  expect(agents.split(OPEN).length).toBe(2);
  expect(agents).toContain("migrate-vite-cloudflare-to-void");
  expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers["cloudflare-docs"].url).toBe(
    "https://docs.mcp.cloudflare.com/mcp",
  );
});

test("re-running replaces the block in place and keeps surrounding text", async () => {
  const dir = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, dir, fake(dir));
  const f = join(dir, "AGENTS.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("void section", "void section edited") + "\ntail\n");
  const { writeAgentFiles } = await import("../../src/agent-files");
  writeAgentFiles(dir);
  const out = readFileSync(f, "utf8");
  expect(out.split(OPEN).length).toBe(2);
  expect(out).toContain("void section edited");
  expect(out).toContain("\ntail\n");
});

test("link-skill symlinks into the given dir and is idempotent", () => {
  const dir = join(tmp(), "skill");
  linkSkill(dir);
  linkSkill(dir);
  for (const n of ["SKILL.md", "routing.md"]) expect(lstatSync(join(dir, n)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, "routing.md"))).toMatch(/docs\/cloudflare-routing\.md$/);
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("Containers");
});

test("--secrets adds an AGENTS.md section on linking, what pull does and what it refuses", async () => {
  const on = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false, secrets: true }, on, fake(on));
  const agents = readFileSync(join(on, "AGENTS.md"), "utf8");
  expect(agents).toContain("## Secrets");
  for (const s of ["secret-sync", "infisical init --project-id", "bun run secrets:pull", ".infisical.yaml", "lacks any key"])
    expect(agents).toContain(s);
  const off = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, off, fake(off));
  expect(readFileSync(join(off, "AGENTS.md"), "utf8")).not.toContain("## Secrets");
});

test("--secrets AGENTS.md documents push as a one-time seed, the naming convention and the production route", async () => {
  const on = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false, secrets: true }, on, fake(on));
  const agents = readFileSync(join(on, "AGENTS.md"), "utf8");
  for (const s of [
    "bun run secrets:push", "one-time seed", "overwrites", "some keys may already have been set",
    "^[A-Z][A-Z0-9_]*$", "__VOID_", "_PREVIOUS", "env.ts",
    "umask 077", "mktemp", "trap 'rm -f \"$f\"' EXIT",
    "```bash\n(\n  set -eo pipefail",
    "infisical export --env=prod --format=dotenv --expand=false --silent | { grep -v '^VITE_' || true; } > \"$f\"",
    "void secret sync \"$f\" --yes", "\n) && infisical run --env=prod -- void deploy", "Workers sync",
  ])
    expect(agents).toContain(s);
});
