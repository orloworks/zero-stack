import { defineHandler } from "void";
import { requireSameOrigin } from "../../../src/admin";
import { confirm } from "../../../src/consent";
import { fields } from "../../../src/lib/fields";

// The Confirm button's POST: the only thing that records consent from a mailed link (the page's GET changes nothing).
export const POST = defineHandler(async (c) => {
  requireSameOrigin(c);
  const out = await confirm((await fields(c)).token);
  return out.status === "confirmed" ? c.json({ status: out.status }) : c.json({ status: out.status }, 400);
});
