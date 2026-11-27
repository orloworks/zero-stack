import { integer, primaryKey, sqliteTable, text } from "void/schema-d1";

// One row per email address that asked for marketing mail, stored lower case. It is not tied to a user: a signed-in user is matched by their verified
// email. The unsubscribe token is random (256 bits), stored here and not signed, and never expires. Pages call src/consent.ts, never these tables.
export const subscriber = sqliteTable("subscriber", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  unsubscribeToken: text("unsubscribe_token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // When the last confirmation mail to this address was requested, whichever list it was for: the ten-minute throttle is per address.
  lastMailAt: integer("last_mail_at", { mode: "timestamp_ms" }),
});

// Confirmation mails sent per clock hour, app-wide: the hourly ceiling. A mail claims a slot here before it is sent and gives it back if the send fails,
// so the count is of real sends, and two requests at once cannot both take the last slot. `hour` is the hour number since the epoch.
export const mailCeiling = sqliteTable("mail_ceiling", {
  hour: integer("hour").primaryKey(),
  sent: integer("sent").notNull(),
});

// One row per subscriber and list, holding the current state only: pending, confirmed or unsubscribed. Asking again overwrites the row.
// source, page and wording are how, where and with what words they were asked. confirmToken is random and valid for seven days from requestedAt.
// Removing a subscriber (src/consent.ts removeSubscriber) deletes both tables' rows explicitly; the cascade is only the backstop.
export const consent = sqliteTable(
  "consent",
  {
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => subscriber.id, { onDelete: "cascade" }),
    list: text("list").notNull(),
    state: text("state").notNull(),
    source: text("source").notNull(),
    page: text("page").notNull(),
    wording: text("wording").notNull(),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    withdrawnAt: integer("withdrawn_at", { mode: "timestamp_ms" }),
    withdrawnHow: text("withdrawn_how"),
    confirmToken: text("confirm_token").unique(),
  },
  (t) => [primaryKey({ columns: [t.subscriberId, t.list] })],
);
