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

// Every descendant of `roots` (a gate's detached children sit in their own groups, outside the gate's).
function descendants(roots: number[]): number[] {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().trim().split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out = new Set<number>(), todo = [...roots];
  for (let r = todo.pop(); r !== undefined; r = todo.pop())
    for (const [pid, ppid] of rows) if (ppid === r && !out.has(pid)) { out.add(pid); todo.push(pid); }
  return [...out];
}

// SIGTERM every group, wait up to graceMs, then SIGKILL stragglers (and their descendants) and wait briefly again.
export async function killChildren(graceMs = 5000): Promise<void> {
  const live = [...children];
  const seen = new Set(descendants(live.map((c) => c.pid))); // snapshot before TERM: orphans lose their parent link
  const signal = (sig: "SIGTERM" | "SIGKILL") => { for (const c of live) try { process.kill(-c.pid, sig); } catch {} };
  const gone = Promise.all(live.map((c) => c.exited));
  signal("SIGTERM");
  const done = await Promise.race([gone.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  signal("SIGKILL"); // stragglers: an exited group leader may have left members behind
  for (const pid of [...seen, ...descendants(live.map((c) => c.pid))]) for (const t of [-pid, pid]) try { process.kill(t, "SIGKILL"); } catch {}
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
