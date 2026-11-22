import { defineHandler } from "void";
import type { Href } from "void/routes";
import { requireAdmin } from "../../src/admin";

// /admin/users is the Users page, which lives at /admin.
export const GET = defineHandler((c) => {
  requireAdmin(c);
  return c.redirect(`/admin${new URL(c.req.url).search}` as Href);
});
