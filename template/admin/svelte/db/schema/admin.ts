import { index, integer, sqliteTable, text } from "void/schema-d1";
// Relative, not "@auth-schema": Void does not resolve that alias when drizzle-kit or the dev server loads the schema (docs/facts.md).
import { userTable } from "../../.void/better-auth-schema";

// One row per change an admin made. The admin and the affected user are kept as ids ("set null": history must outlive a deleted
// user, so this table is the one exception to the cascade rule) and as emails, which the delete hook clears. Pages never touch this
// table directly: they call src/admin.ts, which owns the row shape (auditRow).
export const auditEntry = sqliteTable(
  "audit_entry",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => userTable.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    targetUserId: text("target_user_id").references(() => userTable.id, { onDelete: "set null" }),
    targetEmail: text("target_email"),
    verb: text("verb").notNull(),
    detail: text("detail"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("audit_entry_created_at_idx").on(t.createdAt), index("audit_entry_target_created_at_idx").on(t.targetUserId, t.createdAt)],
);
