// Module 2: the first dev-server start, and what is checked on it before any user exists (shadcn, GET /, the zod-rpc route).
import type { Ctx } from "../shared";

// Starts the dev server; returns the port it came up on (the auth and payments checks build their first address from it).
export async function firstDevChecks(ctx: Ctx): Promise<{ port: number }> {
  const { config, h } = ctx;
  const { port, status } = await h.start();
  if (config.shadcn) {
    const html = await fetch(`http://localhost:${port}/`).then((r) => r.text());
    if (!html.includes('data-slot="button"')) throw new Error("shadcn Button not rendered on /");
    console.log("gate: shadcn Button rendered");
  }
  console.log(`gate: GET / -> ${status}`);
  if (config.zodRpc) {
    const post = (body: unknown) =>
      fetch(`http://localhost:${port}/api/echo`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.status);
    const [bad, good] = [await post({ name: "" }), await post({ name: "zero" })];
    console.log(`gate: POST /api/echo invalid -> ${bad}, valid -> ${good}`);
    if (bad < 400 || bad >= 500 || good !== 200) throw new Error("zod-rpc route did not validate");
  }
  return { port };
}
