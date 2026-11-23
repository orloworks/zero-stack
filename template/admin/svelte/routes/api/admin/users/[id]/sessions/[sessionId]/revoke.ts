import { isAPIError } from "better-auth/api";
import { defineHandler } from "void";
import { getAuth } from "void/auth";
import { listSessions, notFound, requireAdmin, requireSameOrigin } from "../../../../../../../src/admin";

// Revokes one session by id. The page never sees tokens: the token is looked up here and handed to the plugin with the admin's own headers, so the guard checks
// the admin and writes the audit entry. (Never internalAdapter.deleteSession: it skips both.) An id that is not this user's session is a 404.
export const POST = defineHandler(async (c) => {
  requireAdmin(c);
  requireSameOrigin(c);
  const session = (await listSessions(c.req.param("id") ?? "")).find((s) => s.id === c.req.param("sessionId"));
  if (!session) throw notFound();
  try {
    await getAuth(c).api.revokeUserSession({ body: { sessionToken: session.token }, headers: c.req.raw.headers });
  } catch (e) {
    if (!isAPIError(e)) throw e;
    return c.json({ code: e.body?.code, message: e.body?.message }, e.statusCode as 400);
  }
  return c.json({ success: true });
});
