import { integer, sqliteTable, text } from "void/schema-d1";
// Relative, not "@auth-schema": Void does not resolve that alias when drizzle-kit or the dev server loads the schema (docs/facts.md).
import { userTable } from "../../.void/better-auth-schema";

// Invites added in the admin area: an exact email (a@x.com) or a whole domain (@x.com), always lower case, one row each. They admit sign-ups
// beside the SIGNUP_ALLOWLIST secret (src/invites.ts: inviteAllowed). Revoking a row never touches an existing account. Pages call src/invites.ts, never this table.
// addedByUserId is "set null", not cascade: deleting the admin who added an invite must not withdraw it (the audit table is the other such exception).
export const invite = sqliteTable("invite", {
  id: text("id").primaryKey(),
  entry: text("entry").notNull().unique(),
  addedByUserId: text("added_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSentAt: integer("last_sent_at", { mode: "timestamp_ms" }),
});
