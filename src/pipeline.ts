import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAgentFiles } from "./agent-files";
import type { Config } from "./flags";
import { installAuth } from "./installers/auth";
import { installShadcn } from "./installers/shadcn";
import { installTailwind } from "./installers/tailwind";
import { installZodRpc } from "./installers/zod-rpc";
import { CREATE_VOID, NODE_RANGE, OVERRIDES, TRUSTED_DEPENDENCIES } from "./versions";
import { anchorError, editJson } from "./anchor";
import { onTerminate, spawnTracked, terminating } from "./children";

export type Run = (cmd: string[], cwd: string) => Promise<void>;

export const run: Run = async (cmd, cwd) => {
  // stdin is closed: a detached child in the background process group would stop on a TTY read.
  const code = await spawnTracked(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] }).exited;
  if (terminating()) await new Promise(() => {}); // the signal handler is cleaning up and will exit
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed`);
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
  editJson(targetDir, "package.json", (pkg) => {
    if (!pkg.scripts?.postinstall) throw anchorError("scripts.postinstall", "package.json");
    Object.assign(pkg.scripts, {
      verify: "void prepare && vp check && tsc --noEmit && vp build && vp test",
      test: "vp test",
      "db:reset": "void db reset --yes",
    });
    // Void does not handle bun script approvals.
    pkg.trustedDependencies = TRUSTED_DEPENDENCIES;
    pkg.overrides = { ...pkg.overrides, ...OVERRIDES };
  });
  const agents = join(targetDir, "AGENTS.md");
  if (!readFileSync(agents, "utf8").includes("<!--/injected-by-void-->")) throw anchorError("<!--/injected-by-void-->", "AGENTS.md");
  appendFileSync(agents, VERIFY_BLOCK);
  cpSync(join(dirname(fileURLToPath(import.meta.url)), "../template/tests"), join(targetDir, "tests"), { recursive: true });
}

export async function scaffold(config: Config, targetDir: string, exec: Run = run): Promise<void> {
  const existed = existsSync(targetDir);
  if (existed && readdirSync(targetDir).length > 0) throw new Error(`Target directory ${targetDir} is not empty.`);
  // Delete only what zero-stack created: a target that existed (empty) is emptied, not removed.
  const cleanup = () => {
    if (!existed) return rmSync(targetDir, { recursive: true, force: true });
    for (const e of readdirSync(targetDir)) rmSync(join(targetDir, e), { recursive: true, force: true });
  };
  const dispose = onTerminate(cleanup);
  try {
    await exec(
      [process.execPath, "x", `create-void@${CREATE_VOID}`, config.name, "--toolchain", "vite-plus",
        "--framework", config.framework, "--starter", "sqlite", "--deploy", "none", "--git"],
      dirname(targetDir),
    );
    // Also catches a pre-existing target (`create-zero-stack .`) where create-void wrote elsewhere.
    if (!existsSync(join(targetDir, "package.json")))
      throw new Error(`create-void did not produce ${join(targetDir, "package.json")}; it works in ${join(dirname(targetDir), config.name)}, the target directory is ${targetDir}.`);
    // Installers edit deps; the single `bun install` below picks them up.
    if (config.tailwind) installTailwind(targetDir);
    if (config.zodRpc) installZodRpc(targetDir);
    if (config.shadcn) installShadcn(targetDir);
    if (config.auth) installAuth(targetDir, config.framework);
    addAppScripts(targetDir);
    await exec([process.execPath, "install"], targetDir);
    // Leaves the auth migration generated, not applied to any database.
    if (config.auth) await exec([join(targetDir, "node_modules/.bin/void"), "db", "generate"], targetDir);
    writeAgentFiles(targetDir); // before vp check so the block gets formatted too
    // create-void 1.8.0 output fails its own `vp check` on formatting (docs/facts.md).
    await exec([join(targetDir, "node_modules/.bin/vp"), "check", "--fix"], targetDir);
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    dispose();
  }
}
