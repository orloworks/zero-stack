import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { isAdmin, listUsers, PAGE_SIZE, requireAdmin, userStatus } from "../../src/admin";
import { inviteState } from "../../src/invite-state";
import { progressFor, showOnboarding } from "../../src/onboarding";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  requireAdmin(c);
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  // "Deleted x@y.com and their files." arrives from the delete action's redirect.
  const deleted = (c.req.query("deleted") ?? "").slice(0, 200);
  const base = { q, page, pageSize: PAGE_SIZE, deleted, unaudited: c.req.query("unaudited") === "1" };
  try {
    const { rows, total } = await listUsers(q, page);
    const progress = showOnboarding ? await progressFor(rows) : null;
    const users = rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      lastSignInAt: u.lastSignInAt ?? null,
      onboarding: progress?.get(u.id)?.text ?? null,
      status: userStatus({ ...u, bannedAt: u.updatedAt, admin: isAdmin(env.ADMIN_EMAILS, u) }),
    }));
    // A search with no account in an invite-only app also says whether the address is invited (D7).
    const invite = q && total === 0 ? await inviteState(q) : null;
    return { ...base, users, total, invite, onboarding: showOnboarding, loadError: false };
  } catch (e) {
    console.error("admin users load failed", e);
    return { ...base, users: [], total: 0, invite: null, onboarding: false, loadError: true };
  }
});
