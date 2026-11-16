import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graceMs, onTerminate } from "../../src/children";

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
