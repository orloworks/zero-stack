import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs a real gate / ci:full, SIGTERMs it once its temp dir exists and a scaffold is under way,
// and checks exit 143 and that no zs-gate-* temp dir is left behind.
async function termDuring(script: string, args: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "zs-sig-"));
  const left = () => readdirSync(tmp).filter((f) => f.startsWith("zs-gate-"));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts", script), ...args], {
    env: { ...process.env, TMPDIR: tmp }, stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 300 && !left().length && p.exitCode === null; i++) await Bun.sleep(50);
  expect(left().length).toBeGreaterThan(0);
  await Bun.sleep(1500); // past the handler registration, into the scaffold
  p.kill("SIGTERM");
  const code = await Promise.race([p.exited, Bun.sleep(45_000).then(() => { p.kill("SIGKILL"); return "hung" as const; })]);
  return { code, left: left() };
}

test("gate: SIGTERM exits 143 and removes its temp dir", async () => {
  const r = await termDuring("gate.ts", []);
  expect(r).toEqual({ code: 143, left: [] });
}, 60_000);

test("ci:full: SIGTERM exits 143 and no gate temp dir survives", async () => {
  const r = await termDuring("ci-full.ts", ["--force"]);
  expect(r).toEqual({ code: 143, left: [] });
}, 60_000);
