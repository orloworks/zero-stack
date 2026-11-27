import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import type { AuditInput, Verb } from "./admin";

// Guards and audits the Better Auth admin plugin's /admin/* endpoints. The plugin trusts user.role, which would go stale (a de-listed admin
// would keep working until the session expires), so this runs first and decides from ADMIN_EMAILS, live, on every call.
//   before: 404 unless the path is allowlisted and the signed-in user passes isAdmin now; then it is the only writer of user.role, so the plugin's
//           own check (which reads the user fresh from the database) agrees; on remove-user, refuse self, then cancel billing and purge the user's files first (U1).
//   after:  one audit entry for each successful change; a failed write answers 500 AUDIT_WRITE_FAILED (the change stands; the page shows a warning).
// Not on the list, so refused with a 404 even for an admin: list-user-sessions (it returns raw session tokens; the pages read sessions server-side),
// set-role, create-user, update-user, set-user-password, impersonate-user,
// stop-impersonating, has-permission, and any endpoint a later Better Auth adds. Fail closed.
export const ALLOWED = [
  "/admin/list-users",
  "/admin/get-user",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
] as const;

export type GuardOptions = {
  isAdmin: (user: { email: string; emailVerified: boolean }) => boolean;
  audit: (i: AuditInput) => Promise<void>;
  // Deletes the user's stored files; given only with --storage. A failure refuses the delete with everything intact.
  purge?: (userId: string) => Promise<void>;
  // Removes the user's marketing subscriber and consent; given only with --marketing. It throws the 500 itself, and runs ahead of the billing cancel and the purge,
  // so a failed removal leaves the billing and the files too.
  removeSubscriber?: (user: { id: string; email: string }) => Promise<void>;
  // Cancels the user's Stripe subscriptions; given only with --payments. It throws the 500 itself, and runs ahead of the purge so a failure leaves the files too.
  cancelBilling?: (userId: string) => Promise<void>;
};

type Pending = Pick<AuditInput, "actor" | "verb" | "target" | "detail" | "oldValue" | "newValue">;
const AUDITED: Partial<Record<string, Verb>> = {
  "/admin/ban-user": "ban",
  "/admin/unban-user": "unban",
  "/admin/revoke-user-session": "revoke-session",
  "/admin/revoke-user-sessions": "revoke-sessions",
  "/admin/remove-user": "delete-user",
};

const notFound = () => new APIError("NOT_FOUND", { message: "Not Found" });

export function adminGuard(opts: GuardOptions) {
  // What the before hook learned, for the after hook of the same request (both see the same context object).
  const pending = new WeakMap<object, Pending>();
  return {
    id: "admin-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => !!ctx.path?.startsWith("/admin/"),
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path ?? "";
            if (!(ALLOWED as readonly string[]).includes(path)) throw notFound();
            const user = (await getSessionFromCtx(ctx, { disableCookieCache: true }))?.user;
            if (!user) throw notFound();
            const role = (user as { role?: string | null }).role;
            const admin = opts.isAdmin(user);
            // The one writer of role (O3): it follows ADMIN_EMAILS in both directions.
            if (admin !== (role === "admin")) await ctx.context.internalAdapter.updateUser(user.id, { role: admin ? "admin" : "user" });
            if (!admin) throw notFound();

            const verb = AUDITED[path];
            if (!verb) return;
            const actor = { id: user.id, email: user.email };
            const body = (ctx.body ?? {}) as { userId?: unknown; sessionToken?: unknown; banReason?: unknown; banExpiresIn?: unknown };
            if (path === "/admin/revoke-user-session") {
              const found = typeof body.sessionToken === "string" ? await ctx.context.internalAdapter.findSession(body.sessionToken) : null;
              if (found) pending.set(ctx.context, { actor, verb, target: { id: found.user.id, email: found.user.email } });
              return;
            }
            if (body.userId !== undefined && typeof body.userId !== "string") {
              // The plugin coerces userId with z.coerce.string(), so ["id"] would reach it as "id" past this guard: refuse anything else.
              throw new APIError("BAD_REQUEST", { code: "INVALID_USER_ID", message: "userId must be a string" });
            }
            // D12: a ban has no expiry, so the audited state is always banned or active.
            if (verb === "ban" && typeof body === "object" && body !== null && "banExpiresIn" in body) throw new APIError("BAD_REQUEST", { code: "BAN_EXPIRY_NOT_SUPPORTED", message: "A ban has no expiry" });
            const userId = typeof body.userId === "string" ? body.userId : null;
            const target = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
            if (!target) return; // the plugin answers 404 or 400
            if (path === "/admin/remove-user") {
              if (target.id === user.id) throw new APIError("BAD_REQUEST", { code: "YOU_CANNOT_REMOVE_YOURSELF", message: "You cannot remove yourself" });
              await opts.removeSubscriber?.(target);
              await opts.cancelBilling?.(target.id);
              if (opts.purge) {
                try {
                  await opts.purge(target.id);
                } catch (e) {
                  console.error(`storage purge failed for ${target.id}`, e);
                  throw new APIError("INTERNAL_SERVER_ERROR", { code: "STORAGE_PURGE_FAILED", message: "Could not delete the user's files." });
                }
              }
              // O1: no target id, no email, no free text, so the row is correct whichever order the delete's own hooks run in.
              pending.set(ctx.context, { actor, verb, target: null, detail: `deleted user ${target.id}` });
              return;
            }
            // Every successful ban and unban writes one entry, even a repeat: the old value is the effective state now (an expired ban is lifted).
            // shortcut: read here, written in the after-hook, so concurrent changes to one user can log out of order; make it atomic if an app needs a strict history.
            const t = target as { banned?: boolean | null; banExpires?: Date | number | null };
            const was = t.banned && (!t.banExpires || new Date(t.banExpires).getTime() > Date.now()) ? "banned" : "active";
            const reason = typeof body.banReason === "string" && body.banReason.trim() ? body.banReason.trim() : null;
            pending.set(ctx.context, {
              actor,
              verb,
              target: { id: target.id, email: target.email },
              ...(verb === "ban" ? { detail: reason, oldValue: was, newValue: "banned" } : {}),
              ...(verb === "unban" ? { oldValue: was, newValue: "active" } : {}),
            });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => !!ctx.path?.startsWith("/admin/"),
          handler: createAuthMiddleware(async (ctx) => {
            const p = pending.get(ctx.context);
            if (!p || isAPIError(ctx.context.returned)) return;
            pending.delete(ctx.context);
            try {
              await opts.audit(p);
            } catch (e) {
              console.error(`audit write failed (${p.verb})`, e);
              throw new APIError("INTERNAL_SERVER_ERROR", { code: "AUDIT_WRITE_FAILED", message: "The change was made but could not be recorded in the audit log." });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
