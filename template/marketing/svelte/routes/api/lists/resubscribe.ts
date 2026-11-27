import { defineHandler } from "void";
import { requireSameOrigin } from "../../../src/admin";
import { CHECK_INBOX, findList, requestAgain } from "../../../src/consent";
import { afterResponse } from "../../../src/lib/after-response";
import { fields } from "../../../src/lib/fields";

// "Subscribe again" on the unsubscribe page: mails a confirmation and confirms nothing by itself. The token only says whose address to mail; it answers at once and the
// same for a known and an unknown token, because the lookup and the mail happen after the response.
export const POST = defineHandler(async (c) => {
  requireSameOrigin(c);
  const f = await fields(c);
  if (!findList(f.list)) return c.json({ message: "That list doesn't exist." }, 400);
  afterResponse(c, requestAgain(f.token, f.list, { origin: new URL(c.req.url).origin, page: "/unsubscribe" }), "resubscribe confirmation mail");
  return c.json({ message: CHECK_INBOX });
});
