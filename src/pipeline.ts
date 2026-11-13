import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAgentFiles } from "./agent-files";
import type { Config } from "./flags";
import { installTailwind } from "./installers/tailwind";
import { CREATE_VOID, NODE_RANGE } from "./versions";

export type Run = (cmd: string[], cwd: string) => Promise<void>;

const run: Run = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
};

// Void needs real Node on PATH even under bun; process.versions.node is unreliable under bun.
export function preflight(): void {
  const r = Bun.spawnSync(["node", "--version"]);
  const m = r.exitCode === 0 && /^v(\d+)\.(\d+)/.exec(r.stdout.toString());
  const ok = m && (+m[1] === 24 ? +m[2] >= 22 : +m[1] === 26 ? +m[2] >= 12 : +m[1] > 26);
  if (!ok) throw new Error(`Node ${NODE_RANGE} required on PATH (found ${m ? m[0] : "none"}).`);
}

const VERIFY_BLOCK = `
<!-- zero-stack:verify -->
Run \`bun run verify\` before finishing any task; it must pass.
<!-- /zero-stack:verify -->
`;

// Anchored edits to the pinned create-void output; a missing anchor is a hard error.
function addAppScripts(targetDir: string): void {
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.scripts?.postinstall) throw new Error("package.json anchor missing: scripts.postinstall");
  Object.assign(pkg.scripts, {
    verify: "void prepare && vp check && vp build && vp test",
    test: "vp test",
    "db:reset": "void db reset --yes",
  });
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const agents = join(targetDir, "AGENTS.md");
  if (!readFileSync(agents, "utf8").includes("<!--/injected-by-void-->"))
    throw new Error("AGENTS.md anchor missing: <!--/injected-by-void-->");
  appendFileSync(agents, VERIFY_BLOCK);
  cpSync(join(dirname(fileURLToPath(import.meta.url)), "../template/tests"), join(targetDir, "tests"), { recursive: true });
}

export async function scaffold(config: Config, targetDir: string, exec: Run = run): Promise<void> {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0)
    throw new Error(`Target directory ${targetDir} is not empty.`);
  try {
    await exec(
      [process.execPath, "x", `create-void@${CREATE_VOID}`, config.name, "--toolchain", "vite-plus",
        "--framework", config.framework, "--starter", "sqlite", "--deploy", "none", "--git"],
      dirname(targetDir),
    );
    // Installers edit deps; the single `bun install` below picks them up.
    if (config.tailwind) installTailwind(targetDir);
    // Void does not handle bun script approvals.
    const pkgPath = join(targetDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.trustedDependencies = ["esbuild", "workerd", "sharp"];
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    addAppScripts(targetDir);
    await exec([process.execPath, "install"], targetDir);
    writeAgentFiles(targetDir); // before vp check so the block gets formatted too
    // create-void 1.8.0 output fails its own `vp check` on formatting (docs/facts.md).
    await exec([join(targetDir, "node_modules/.bin/vp"), "check", "--fix"], targetDir);
  } catch (e) {
    rmSync(targetDir, { recursive: true, force: true });
    throw e;
  }
}
