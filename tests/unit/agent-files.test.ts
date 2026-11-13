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
