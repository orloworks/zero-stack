import { defineMiddleware } from "void";
import { getUser } from "void/auth";
import { env } from "void/env";
import { isAdmin } from "../src/admin";

// Every /admin page and /api/admin route answers 404 unless the signed-in user is an admin right now: a new admin page is gated before it exists.
// Each loader and route also calls requireAdmin (it needs the user), so a path spelling this check misses is still refused there.
export default defineMiddleware(async (c, next) => {
  const path = c.req.path.toLowerCase();
  const admin = path === "/admin" || path.startsWith("/admin/") || path === "/api/admin" || path.startsWith("/api/admin/");
  if (admin && !isAdmin(env.ADMIN_EMAILS, getUser())) return c.notFound();
  await next();
});
