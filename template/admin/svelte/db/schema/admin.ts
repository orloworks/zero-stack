import { index, integer, primaryKey, sqliteTable, text } from "void/schema-d1";
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

// Where each user is in onboarding: one row per declared step they reached (src/onboarding.ts). "Signed up" and "Email verified" are derived from the user
// row and never stored (E14). It is user-owned, so it cascades on user delete; only the audit table is the exception.
export const onboardingStep = sqliteTable(
  "onboarding_step",
  {
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    reachedAt: integer("reached_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.step] })],
);

// The global state of a declared feature (declared in src/app/features.ts): "on", "off" or "kill". No row means off. Rows for features no longer declared are ignored, so deleting a
// feature is a code change only. Pages and routes call src/access.ts, never this table.
export const featureSwitch = sqliteTable("feature_switch", {
  feature: text("feature").primaryKey(),
  state: text("state").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// One user's override of a feature: "on" or "off". No row means "use global". User-owned, so it cascades on user delete.
export const featureOverride = sqliteTable(
  "feature_override",
  {
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    feature: text("feature").notNull(),
    state: text("state").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.feature] })],
);

// The stored value of a declared setting (src/app/settings.ts), as text. No row means the declared default. Rows for settings no longer declared, or whose value no longer
// fits the declaration, are ignored. Pages and routes call src/settings.ts, never this table.
export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
