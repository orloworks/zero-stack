// One shape for every admin form (D6, D8): pending while the call runs, then done, done-unaudited (the change stands but its audit entry failed) or error.
export type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done" }
  | { status: "done-unaudited" }
  | { status: "error"; message: string };

export const UNAUDITED_WARNING = "Warning: this change was not recorded in the audit log.";
const NETWORK = "Something went wrong. Check your connection and try again.";

type Failure = { code?: string; message?: string } | null | undefined;

// `call` returns a Better Auth client result ({ data, error }) or a fetch Response. `set` receives pending, then the outcome, which is also returned.
export async function runAction(set: (s: ActionState) => void, call: () => Promise<unknown>, fallback = "Something went wrong."): Promise<ActionState> {
  set({ status: "pending" });
  let failure: Failure;
  try {
    const result = await call();
    failure = result instanceof Response ? (result.ok ? null : ((await result.json().catch(() => ({}))) as Failure)) : (result as { error?: Failure } | null)?.error;
  } catch {
    const state: ActionState = { status: "error", message: NETWORK };
    set(state);
    return state;
  }
  const state: ActionState = !failure ? { status: "done" } : failure.code === "AUDIT_WRITE_FAILED" ? { status: "done-unaudited" } : { status: "error", message: failure.message || fallback };
  set(state);
  return state;
}
