// Every permutation through scripts/gate.ts: max 2 at once, under nice, bun's shared install cache,
// skipped when nothing relevant changed since its last green run (.ci-cache/green.json, gitignored).
// --force ignores that cache (before a release, run it with --force).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { onTerminate, spawnTracked } from "../src/children";
import { CREATE_VOID } from "../src/versions";
import { MATRIX } from "./matrix";

export const MAX_PARALLEL = 2;

// Runs fn over items with at most `limit` in flight; after a failure nothing new starts, in-flight ones finish.
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<boolean>): Promise<boolean[]> {
  const results: boolean[] = new Array(items.length);
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
      if (!results[i]) failed = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const root = resolve(import.meta.dir, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

export const isGreen = (green: Record<string, string>, name: string, h: string, force: boolean) => !force && green[name] === h;

// src/ already contains src/versions.ts; scripts/gate/ (checks/ included: files() recurses) holds the gate harness and the check modules that scripts/gate.ts runs. The Node on PATH (not process.versions) is what Void runs on.
export const nodeVersion = (): string => Bun.spawnSync(["node", "--version"], { env: process.env }).stdout.toString();

export function hash(repo: string, args: string[], node: string): string {
  const h = createHash("sha256").update(args.join(" ")).update(Bun.version).update(node);
  const all = [
    ...files(join(repo, "src")), ...files(join(repo, "template")), ...files(join(repo, "scripts/gate")),
    ...["docs/cloudflare-routing.md", "scripts/gate.ts", "package.json", "bun.lock"].map((f) => join(repo, f)),
  ];
  for (const f of all.sort()) h.update(f.slice(repo.length)).update(readFileSync(f));
  return h.digest("hex");
}

if (import.meta.main) {
  const cacheDir = join(root, ".ci-cache");
  const greenFile = join(cacheDir, "green.json");
  mkdirSync(cacheDir, { recursive: true });
  const force = process.argv.includes("--force");
  const green: Record<string, string> = existsSync(greenFile) ? JSON.parse(readFileSync(greenFile, "utf8")) : {};
  onTerminate(() => {}, 20_000); // each gate cleans up on SIGTERM; wait for them before exiting
  const node = nodeVersion(); // once per run; every permutation shares the same PATH
  // Install create-void into bun's shared cache once: two cold `bun x` runs in parallel race on the link (EEXIST).
  // Exit code ignored: without a project name it exits 1 after installing.
  Bun.spawnSync([process.execPath, "x", `create-void@${CREATE_VOID}`, "--help"], { cwd: tmpdir(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const t0 = Date.now();
  const status: Record<string, string> = {};

  const ok = await runPool(MATRIX, MAX_PARALLEL, async (p) => {
    const h = hash(root, p.args, node);
    if (isGreen(green, p.name, h, force)) { status[p.name] = "skipped (unchanged)"; console.log(`${p.name}: skipped (unchanged)`); return true; }
    const start = Date.now();
    console.log(`${p.name}: running (${p.args.join(" ") || "no flags"})`);
    const child = spawnTracked(["nice", process.execPath, join(root, "scripts/gate.ts"), ...p.args, "--name", `zs-${p.name}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const secs = Math.round((Date.now() - start) / 1000);
    if (code === 0) {
      green[p.name] = h;
      writeFileSync(greenFile, JSON.stringify(green, null, 2));
      status[p.name] = `passed (${secs}s)`;
    } else {
      status[p.name] = `FAILED (${secs}s)`;
      const why = `${out}\n${err}`.split("\n").find((l) => l.startsWith("gate failed:"));
      const killed = child.signalCode ? ` (killed by ${child.signalCode})` : "";
      console.error(`--- ${p.name} failed${killed}: ${why ?? "no 'gate failed:' line"} ---`);
      const tail = (label: string, t: string) => `[${label}]\n${t.split("\n").slice(-40).join("\n")}`;
      console.error(`${tail("stdout", out)}\n${tail("stderr", err)}`);
    }
    console.log(`${p.name}: ${status[p.name]}`);
    return code === 0;
  });

  console.log("\nci:full summary");
  for (const p of MATRIX) console.log(`  ${p.name.padEnd(12)} ${status[p.name] ?? "not run (earlier failure)"}`);
  console.log(`wall time ${Math.round((Date.now() - t0) / 1000)}s`);
  const bad = MATRIX.filter((_, i) => ok[i] === false).map((p) => p.name);
  if (bad.length || ok.some((r) => r === undefined)) {
    console.error(`ci:full FAILED: ${bad.join(", ") || "incomplete"}`);
    process.exit(1);
  }
}
