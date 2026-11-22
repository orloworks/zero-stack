import { defineHandler, type InferProps } from "void";
import { getAuth, getSession } from "void/auth";
import { env } from "void/env";
import { deviceLabel, findUser, isAdmin, notFound, requireAdmin, setPasswordLink, userStatus } from "../../../src/admin";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const me = requireAdmin(c);
  const user = await findUser(c.req.param("id") ?? "");
  if (!user) throw notFound();
  // Sessions come from the admin plugin (through the guard), not the table.
  const { sessions } = await getAuth(c).api.listUserSessions({ body: { userId: user.id }, headers: c.req.raw.headers });
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
      token: s.token,
      device: deviceLabel(s.userAgent),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      current: s.id === currentSession,
    })),
    back: `/admin${back.size ? `?${back}` : ""}`,
  };
});
