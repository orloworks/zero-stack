import type { Subprocess } from "bun";

// Every child the CLI, the gate and ci:full start. Each runs in its own process group (detached) so a
// signal can take down its whole tree; nothing may outlive the directory it writes into.
const children = new Set<Subprocess<any, any, any>>();
let down = false;

export function spawnTracked<In extends Bun.SpawnOptions.Writable = "ignore", Out extends Bun.SpawnOptions.Readable = "pipe", Err extends Bun.SpawnOptions.Readable = "inherit">(
  cmd: string[],
  opts: Bun.SpawnOptions.OptionsObject<In, Out, Err> = {},
): Subprocess<In, Out, Err> {
  const p = Bun.spawn(cmd, { ...opts, detached: true });
  children.add(p);
  void p.exited.then(() => children.delete(p));
  return p;
}

// A process as `ps` sees it; `id` (pid + start time) names one process, so a reused pid never matches.
export type Proc = { pid: number; ppid: number; id: string };

function snapshot(): Proc[] {
  return Bun.spawnSync(["ps", "-axo", "pid=,ppid=,lstart="]).stdout.toString().trim().split("\n").map((l) => {
    const [pid, ppid, ...start] = l.trim().split(/\s+/);
    return { pid: +pid!, ppid: +ppid!, id: `${pid} ${start.join(" ")}` };
  });
}

// Every descendant of `roots` (a gate's detached children sit in their own groups, outside the gate's).
function descendants(rows: Proc[], roots: number[]): Proc[] {
  const out = new Map<number, Proc>(), todo = [...roots];
  for (let r = todo.pop(); r !== undefined; r = todo.pop())
    for (const p of rows) if (p.ppid === r && !out.has(p.pid)) { out.set(p.pid, p); todo.push(p.pid); }
  return [...out.values()];
}

// What the SIGKILL sweep may hit: processes still alive from the pre-TERM snapshot (same pid AND start time;
// orphans lost their parent link) plus current descendants of the run's children.
export function sweepTargets(seen: Set<string>, now: Proc[], roots: number[]): number[] {
  return [...new Set([...now.filter((p) => seen.has(p.id)), ...descendants(now, roots)].map((p) => p.pid))];
}

// SIGTERM every group, wait up to graceMs, then SIGKILL stragglers (and their descendants) and wait briefly again.
export async function killChildren(graceMs = 5000): Promise<void> {
  const live = [...children];
  const roots = live.map((c) => c.pid);
  const seen = new Set(descendants(snapshot(), roots).map((p) => p.id));
  const running = () => live.filter((c) => c.exitCode === null && c.signalCode === null); // an unreaped leader's pid is still ours
  const gone = Promise.all(live.map((c) => c.exited));
  for (const c of running()) try { process.kill(-c.pid, "SIGTERM"); } catch {}
  const done = await Promise.race([gone.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  for (const c of running()) try { process.kill(-c.pid, "SIGKILL"); } catch {}
  for (const pid of sweepTargets(seen, snapshot(), roots)) for (const t of [-pid, pid]) try { process.kill(t, "SIGKILL"); } catch {}
  if (!done) await Promise.race([gone, Bun.sleep(2000)]);
}

export const terminating = () => down;

// One shared SIGINT/SIGTERM handler: kill and await all children, run every registered cleanup, exit 130/143.
// Returns the disposer; the process listeners are removed when the last cleanup is disposed.
const cleanups = new Set<() => void>();
const handlers = { SIGINT: 130, SIGTERM: 143 } as const;
const graces = new Map<() => void, number>();
export const graceMs = () => Math.max(5000, ...graces.values());
const onSignal = (sig: keyof typeof handlers) => async () => {
  if (down) return;
  down = true;
  console.error(`received ${sig}, stopping children and cleaning up`);
  await killChildren(graceMs());
  for (const c of cleanups) try { c(); } catch {}
  process.exit(handlers[sig]);
};
const listeners = { SIGINT: onSignal("SIGINT"), SIGTERM: onSignal("SIGTERM") };

// grace: how long to wait for children after SIGTERM (a parent of other signal-handling parents waits longer).
export function onTerminate(cleanup: () => void, grace = 5000): () => void {
  graces.set(cleanup, grace);
  if (!cleanups.size) for (const s of Object.keys(listeners) as (keyof typeof listeners)[]) process.on(s, listeners[s]);
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    graces.delete(cleanup);
    if (!cleanups.size) for (const s of Object.keys(listeners) as (keyof typeof listeners)[]) process.off(s, listeners[s]);
  };
}
