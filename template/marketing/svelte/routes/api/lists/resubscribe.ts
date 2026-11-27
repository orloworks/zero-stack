import { defineHandler } from "void";
import { requireSameOrigin } from "../../../src/admin";
import { CHECK_INBOX, requestAgain } from "../../../src/consent";
import { fields } from "../../../src/lib/fields";

// "Subscribe again" on the unsubscribe page: mails a confirmation and confirms nothing by itself. The token only says whose address to mail; an unknown one gets the same answer.
export const POST = defineHandler(async (c) => {
  requireSameOrigin(c);
  const f = await fields(c);
  try {
    if ((await requestAgain(f.token, f.list, { origin: new URL(c.req.url).origin, page: "/unsubscribe" })) === "bad-list") return c.json({ message: "That list doesn't exist." }, 400);
  } catch (e) {
    console.error("resubscribe confirmation mail failed", e instanceof Error ? e.message : "unknown error");
    return c.json({ message: "Couldn't send the confirmation mail. Try again later." }, 502);
  }
  return c.json({ message: CHECK_INBOX });
});
