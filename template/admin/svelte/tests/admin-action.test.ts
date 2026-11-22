import { expect, it } from "vite-plus/test";
import { type ActionState, runAction } from "../src/lib/admin-action";

const run = async (call: () => Promise<unknown>) => {
  const seen: ActionState[] = [];
  const last = await runAction((s) => seen.push(s), call);
  return { seen: seen.map((s) => s.status), last };
};

it("goes pending, then done, for a Better Auth result with no error", async () => {
  expect(await run(async () => ({ data: {}, error: null }))).toMatchObject({ seen: ["pending", "done"], last: { status: "done" } });
});

it("maps AUDIT_WRITE_FAILED to done-unaudited: the change stands but was not recorded", async () => {
  const r = await run(async () => ({ data: null, error: { code: "AUDIT_WRITE_FAILED", message: "x", status: 500 } }));
  expect(r).toMatchObject({ seen: ["pending", "done-unaudited"], last: { status: "done-unaudited" } });
});

it("maps the same code from a fetch Response, and any other failure to an error with its message", async () => {
  const audit = new Response(JSON.stringify({ code: "AUDIT_WRITE_FAILED" }), { status: 500 });
  expect((await run(async () => audit)).last.status).toBe("done-unaudited");
  const other = await run(async () => ({ error: { code: "YOU_CANNOT_BAN_YOURSELF", message: "You cannot ban yourself" } }));
  expect(other.last).toEqual({ status: "error", message: "You cannot ban yourself" });
  expect((await run(async () => new Response("{}", { status: 400 }))).last).toEqual({ status: "error", message: "Something went wrong." });
  expect((await run(async () => new Response(null, { status: 204 }))).last.status).toBe("done");
});

it("a thrown call (offline) is an error with the connection message, and the fallback applies when the server gave none", async () => {
  expect((await run(() => Promise.reject(new Error("offline")))).last).toEqual({ status: "error", message: "Something went wrong. Check your connection and try again." });
  const seen: ActionState[] = [];
  await runAction((s) => seen.push(s), async () => ({ error: {} }), "Couldn't ban.");
  expect(seen.at(-1)).toEqual({ status: "error", message: "Couldn't ban." });
});
