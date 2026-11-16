import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graceMs, onTerminate, sweepTargets } from "../../src/children";

test("the SIGKILL sweep skips a pid reused since the snapshot", () => {
  const seen = new Set(["10 Mon Nov 16 05:00:00 2026", "11 Mon Nov 16 05:00:00 2026"]);
  const now = [
    { pid: 10, ppid: 1, id: "10 Mon Nov 16 05:00:00 2026" }, // orphaned straggler: still the same process
    { pid: 11, ppid: 1, id: "11 Mon Nov 16 05:00:15 2026" }, // pid reused by an unrelated process
    { pid: 12, ppid: 99, id: "12 Mon Nov 16 05:00:16 2026" }, // new descendant of a run's child
  ];
  expect(sweepTargets(seen, now, [99]).sort()).toEqual([10, 12]);
});

test("a run's grace timeout ends with its disposer", () => {
  const dispose = onTerminate(() => {}, 30_000);
  expect(graceMs()).toBe(30_000);
  dispose();
  expect(graceMs()).toBe(5000);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("after the grace timeout a SIGTERM-ignoring child's own detached children are killed too", async () => {
  const pidfile = join(mkdtempSync(join(tmpdir(), "zs-kill-")), "pid");
  // child: ignores SIGTERM and starts a detached grandchild (its own process group), recording its pid
  const child = `process.on("SIGTERM", () => {});
    const g = Bun.spawn(["sleep", "60"], { detached: true });
    require("node:fs").writeFileSync(${JSON.stringify(pidfile)}, String(g.pid));
    setInterval(() => {}, 1000);`;
  const parent = `import { spawnTracked, killChildren } from ${JSON.stringify(join(import.meta.dir, "../../src/children"))};
    spawnTracked([process.execPath, "-e", ${JSON.stringify(child)}]);
    while (true) { try { require("node:fs").readFileSync(${JSON.stringify(pidfile)}); break; } catch { await Bun.sleep(50); } }
    await killChildren(500);`;
  const p = Bun.spawn([process.execPath, "-e", parent], { stdout: "ignore", stderr: "ignore" });
  const done = await Promise.race([p.exited, Bun.sleep(20_000).then(() => "hung" as const)]);
  if (done === "hung") p.kill("SIGKILL");
  expect(done).toBe(0);
  const pid = +readFileSync(pidfile, "utf8");
  for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
  const survived = alive(pid);
  if (survived) process.kill(pid, "SIGKILL");
  expect(survived).toBe(false);
}, 30_000);
