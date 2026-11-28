import { defineHandler } from "void";
import { unsubscribe } from "../../../src/consent";
import { fields } from "../../../src/lib/fields";

// The one-click unsubscribe (RFC 8058): the List-Unsubscribe header of every marketing mail points here, and the unsubscribe page posts here.
// It needs no sign-in, no cookie and no Origin, and that is the whole exemption: it does not call requireSameOrigin and never reads a session (no getUser,
// requireAuth or cookie), and it acts only on the secret token in its own address. Void applies no origin check to a route handler; Better Auth's
// check covers /api/auth only. Every other route under /api/lists calls requireSameOrigin.
// The token and the list come from the address (the header's URL); the body may carry `scope=all` and the mail app's `List-Unsubscribe=One-Click`.
// The answer is 200 with no redirect, repeatable, and the same for an unknown token. A database failure is a 500, never a false "unsubscribed".
export const POST = defineHandler(async (c) => {
  const f = await fields(c);
  const token = c.req.query("token") ?? f.token;
  const list = c.req.query("list") ?? f.list ?? "";
  // No list means every list: the standard one-click POST to a URL without `&list=` must never be dropped.
  await unsubscribe(token, f.scope === "all" || !list ? "all" : { list },f["List-Unsubscribe"] === "One-Click" ? "one-click" : "link");
  return c.json({ message: "You are unsubscribed." });
});
