// Every permutation through scripts/gate.ts: max 2 at once, under nice, one shared bun cache,
// skipped when nothing relevant changed since its last green run (.ci-cache/green.json, gitignored).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

// src/ already contains src/versions.ts.
function hash(args: string[]): string {
  const h = createHash("sha256").update(args.join(" "));
  for (const f of [...files(join(root, "src")), ...files(join(root, "template"))].sort())
    h.update(f).update(readFileSync(f));
  return h.digest("hex");
}

if (import.meta.main) {
  const cacheDir = join(root, ".ci-cache");
  const greenFile = join(cacheDir, "green.json");
  mkdirSync(join(cacheDir, "bun-install"), { recursive: true });
  const green: Record<string, string> = existsSync(greenFile) ? JSON.parse(readFileSync(greenFile, "utf8")) : {};
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  for (const s of ["SIGINT", "SIGTERM"] as const)
    process.on(s, () => { for (const c of children) c.kill("SIGTERM"); }); // gate cleans up on SIGTERM
  const t0 = Date.now();
  const status: Record<string, string> = {};

  const ok = await runPool(MATRIX, MAX_PARALLEL, async (p) => {
    const h = hash(p.args);
    if (green[p.name] === h) { status[p.name] = "skipped (unchanged)"; console.log(`${p.name}: skipped (unchanged)`); return true; }
    const start = Date.now();
    console.log(`${p.name}: running (${p.args.join(" ") || "no flags"})`);
    const child = Bun.spawn(["nice", process.execPath, join(root, "scripts/gate.ts"), ...p.args, "--name", `zs-${p.name}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(cacheDir, "bun-install") },
    });
    children.add(child);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    children.delete(child);
    const secs = Math.round((Date.now() - start) / 1000);
    if (code === 0) {
      green[p.name] = h;
      writeFileSync(greenFile, JSON.stringify(green, null, 2));
      status[p.name] = `passed (${secs}s)`;
    } else {
      status[p.name] = `FAILED (${secs}s)`;
      console.error(`--- ${p.name} output (tail) ---\n${(out + err).split("\n").slice(-40).join("\n")}`);
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
