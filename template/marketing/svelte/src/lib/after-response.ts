// Runs work after the response has gone, so the answer cannot depend on how long the work took (and so on who is subscribed). On Workers the context's `waitUntil`
// keeps the request alive until the work ends (Hono's `c.executionCtx`, which Void's handlers get); a failure is logged, never thrown. With no execution context
// (a test, a Node run) the promise simply runs on its own.
export function afterResponse(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>, what: string): void {
  const guarded = work.catch((e) => console.error(`${what} failed`, e instanceof Error ? e.message : "unknown error"));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // no execution context: `guarded` is already running
  }
}
