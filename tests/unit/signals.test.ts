import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripts = join(import.meta.dir, "../../scripts");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Polls (bounded) until `ready()` holds, SIGTERMs the process, and returns its exit code (bounded wait).
async function termWhen(p: Bun.Subprocess, ready: () => boolean) {
  for (let i = 0; i < 600 && !ready() && p.exitCode === null; i++) await Bun.sleep(50);
  expect(ready()).toBe(true); // a readiness signal, not a fixed sleep: fails fast if the run never got going
  p.kill("SIGTERM");
  return Promise.race([p.exited, Bun.sleep(45_000).then(() => { p.kill("SIGKILL"); return "hung" as const; })]);
}

// A real gate / ci:full is "under way" once create-void has created the app inside its zs-gate-* temp dir.
async function gateTerm(script: string, args: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "zs-sig-"));
  const gateDirs = () => readdirSync(tmp).filter((f) => f.startsWith("zs-gate-"));
  const p = Bun.spawn([process.execPath, join(scripts, script), ...args], { env: { ...process.env, TMPDIR: tmp }, stdout: "ignore", stderr: "ignore" });
  const code = await termWhen(p, () => gateDirs().some((d) => readdirSync(join(tmp, d)).length > 0));
  return { code, left: gateDirs() };
}

test("gate: SIGTERM exits 143 and removes its temp dir", async () => {
  expect(await gateTerm("gate.ts", [])).toEqual({ code: 143, left: [] });
}, 60_000);

test("ci:full: SIGTERM exits 143 and no gate temp dir survives", async () => {
  expect(await gateTerm("ci-full.ts", ["--force"])).toEqual({ code: 143, left: [] });
}, 60_000);

test("the real CLI (src/index.ts): SIGTERM mid-create-void exits 143, removes the target, leaves no child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "zs-cli-"));
  const name = `zs-sigtest-${Math.random().toString(36).slice(2, 8)}`;
  const procs = () => Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n").filter((l) => l.includes(name));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), name], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const code = await termWhen(p, () => existsSync(join(cwd, name)));
  for (let i = 0; i < 40 && procs().some((l) => !l.includes("ps -axo")); i++) await Bun.sleep(50);
  expect({ code, dir: existsSync(join(cwd, name)), procs: procs().filter((l) => alive(+l.trim().split(/\s+/)[0]!)) }).toEqual({ code: 143, dir: false, procs: [] });
}, 60_000);
