import type { Subprocess } from "bun";

// Every child the CLI, the gate and ci:full start. Each runs in its own process group (detached) so a
// signal can take down its whole tree; nothing may outlive the directory it writes into.
const children = new Set<Subprocess>();
let down = false;

export function spawnTracked(cmd: string[], opts: Parameters<typeof Bun.spawn>[1] = {}): Subprocess {
  const p = Bun.spawn(cmd, { ...opts, detached: true });
  children.add(p);
  void p.exited.then(() => children.delete(p));
  return p;
}

// SIGTERM every group, wait up to graceMs, then SIGKILL stragglers and wait briefly again.
export async function killChildren(graceMs = 5000): Promise<void> {
  const live = [...children];
  const signal = (sig: "SIGTERM" | "SIGKILL") => { for (const c of live) try { process.kill(-c.pid, sig); } catch {} };
  const gone = Promise.all(live.map((c) => c.exited));
  signal("SIGTERM");
  const done = await Promise.race([gone.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  signal("SIGKILL"); // stragglers: an exited group leader may have left members behind
  if (!done) await Promise.race([gone, Bun.sleep(2000)]);
}

export const terminating = () => down;

// One shared SIGINT/SIGTERM handler: kill and await all children, run every registered cleanup, exit 130/143.
// Returns the disposer; the process listeners are removed when the last cleanup is disposed.
const cleanups = new Set<() => void>();
const handlers = { SIGINT: 130, SIGTERM: 143 } as const;
const onSignal = (sig: keyof typeof handlers) => async () => {
  if (down) return;
  down = true;
  await killChildren();
  for (const c of cleanups) try { c(); } catch {}
  process.exit(handlers[sig]);
};
const listeners = { SIGINT: onSignal("SIGINT"), SIGTERM: onSignal("SIGTERM") };

export function onTerminate(cleanup: () => void): () => void {
  if (!cleanups.size) for (const s of Object.keys(listeners) as (keyof typeof listeners)[]) process.on(s, listeners[s]);
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (!cleanups.size) for (const s of Object.keys(listeners) as (keyof typeof listeners)[]) process.off(s, listeners[s]);
  };
}
