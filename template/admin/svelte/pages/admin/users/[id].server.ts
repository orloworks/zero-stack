import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { env } from "void/env";
import { deviceLabel, findUser, listSessions, isAdmin, notFound, requireAdmin, setPasswordLink, userStatus } from "../../../src/admin";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const me = requireAdmin(c);
  const user = await findUser(c.req.param("id") ?? "");
  if (!user) throw notFound();
  const sessions = await listSessions(user.id); // the page gets ids, never tokens (CSO-1)
  const currentSession = getSession()?.session.id;
  const back = new URLSearchParams();
  for (const k of ["q", "page"]) if (c.req.query(k)) back.set(k, c.req.query(k)!);
  const admin = isAdmin(env.ADMIN_EMAILS, user);
  return {
    user: { id: user.id, email: user.email, name: user.name, banned: !!user.banned },
    isMe: user.id === me.id,
    isAdmin: admin,
    kind: setPasswordLink(user) ? ("set-password" as const) : ("reset" as const),
    status: userStatus({ ...user, bannedAt: user.updatedAt, admin }),
    sessions: sessions.map((s) => ({
      id: s.id,
      device: deviceLabel(s.userAgent),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.id === currentSession,
    })),
    back: `/admin${back.size ? `?${back}` : ""}`,
  };
});
