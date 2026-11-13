import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// dir override exists so tests never touch the real home directory.
export function linkSkill(dir = join(homedir(), ".claude/skills/cloudflare-routing")): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of [
    ["SKILL.md", "skills/cloudflare-routing/SKILL.md"],
    ["routing.md", "docs/cloudflare-routing.md"],
  ]) {
    rmSync(join(dir, name), { force: true });
    symlinkSync(join(root, src), join(dir, name));
  }
}

if (import.meta.main) {
  linkSkill(process.argv[2]);
  console.log("linked cloudflare-routing skill");
}
