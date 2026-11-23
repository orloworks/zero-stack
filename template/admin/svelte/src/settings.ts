import { requireAdmin, auditRow } from "./admin";
import { parseSetting, resolveSetting, type SettingDecl, type SettingValue, storedForm } from "./lib/setting-value";

// Runtime settings. Declare one by adding it to SETTINGS: a key, a type (text, number with optional min and max, boolean, or a choice of fixed values), a default and a
// description. Read it anywhere on the server with `await setting("key")`: it returns the stored value or the default, typed from the declaration. An admin edits
// each one on the Settings page, one form per setting, and can reset it to the default. A setting is never a secret: admins and the audit log see every value, and
// the Settings page is plain text. Put secrets in env.ts. The scaffold ships four examples (and routes/api/example-settings.ts, which reads them): replace them.
export const SETTINGS = {
  "example-text": { type: "text", default: "Hello", description: "A line of text the app shows somewhere." },
  "example-number": { type: "number", default: 10, min: 1, max: 100, description: "A number between 1 and 100." },
  "example-toggle": { type: "boolean", default: false, description: "An on/off switch." },
  "example-choice": { type: "choice", values: ["small", "medium", "large"], default: "medium", description: "One of a fixed set of values." },
} as const satisfies Record<string, SettingDecl>;
export type SettingKey = keyof typeof SETTINGS;
export type ValueOf<K extends SettingKey> = (typeof SETTINGS)[K] extends { type: "number" }
  ? number
  : (typeof SETTINGS)[K] extends { type: "boolean" }
    ? boolean
    : (typeof SETTINGS)[K] extends { type: "choice"; values: readonly (infer V)[] }
      ? V
      : string;

type Ctx = Parameters<typeof requireAdmin>[0];
type Result = { ok: true } | { ok: false; status: 400 | 404; message: string };
const refuse = (status: 400 | 404, message: string): Result => ({ ok: false, status, message });

// void/db and @schema are imported on use: Void's plugin loads auth.ts at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")), ...(await import("../.void/better-auth-schema")) });

const declared = (key: string): key is SettingKey => Object.hasOwn(SETTINGS, key);
const decl = (key: SettingKey): SettingDecl => SETTINGS[key];

// The typed getter: the stored value, or the default when nothing is stored or the stored text no longer fits the declaration. A database failure throws.
export async function setting<K extends SettingKey>(key: K): Promise<ValueOf<K>> {
  const { db, eq, setting: table } = await store();
  const row = (await db.select().from(table).where(eq(table.key, key)).limit(1))[0];
  return resolveSetting(decl(key), row?.value).value as ValueOf<K>;
}

// Admin only (404 for anyone else). `set` and `reset` are bound to the admin who called this: each writes the change and its audit entry in one db.batch, so a change
// is never unrecorded and a request that loses a race to another writes nothing.
export function adminSettings(c: Ctx) {
  const actor = requireAdmin(c);
  return {
    async list() {
      const { db, setting: table } = await store();
      const stored = new Map((await db.select().from(table)).map((r) => [r.key, r.value]));
      return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
        const d = decl(key);
        const { value, invalid } = resolveSetting(d, stored.get(key));
        return { key, decl: d, value, invalid, hasRow: stored.has(key) };
      });
    },
    async set(key: string, raw: unknown): Promise<Result> {
      if (!declared(key)) return refuse(400, "That setting is not declared in src/settings.ts.");
      const d = decl(key);
      const parsed = parseSetting(d, raw);
      if (!parsed.ok) return refuse(400, parsed.message);
      const { db, eq, setting: table, auditEntry } = await store();
      const now = new Date();
      const old = (await db.select().from(table).where(eq(table.key, key)).limit(1))[0]?.value ?? storedForm(d.default);
      const value = storedForm(parsed.value);
      await db.batch([
        db.insert(table).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: table.key, set: { value, updatedAt: now } }),
        db.insert(auditEntry).values(auditRow({ actor, verb: "set-setting", detail: key, oldValue: old, newValue: value }, now)),
      ]);
      return { ok: true };
    },
    async reset(key: string): Promise<Result> {
      if (!declared(key)) return refuse(400, "That setting is not declared in src/settings.ts.");
      const { db, and, eq, sql, setting: table, auditEntry } = await store();
      const now = new Date();
      const row = (await db.select().from(table).where(eq(table.key, key)).limit(1))[0];
      if (!row) return refuse(404, "Already at the default.");
      const here = and(eq(table.key, key), eq(table.value, row.value));
      // The audit row is inserted only while the row it describes still exists, in the same batch as the delete: a request that lost a race inserts and deletes nothing.
      const audit = auditRow({ actor, verb: "reset-setting", detail: key, oldValue: row.value, newValue: storedForm(decl(key).default) }, now);
      const params = Object.values({ ...audit, createdAt: audit.createdAt.getTime() }).map((v) => sql`${v}`);
      const [inserted] = await db.batch([
        db.insert(auditEntry).select(sql`select ${sql.join(params, sql`, `)} where exists (select 1 from ${table} where ${here})`),
        db.delete(table).where(here),
      ]);
      const changes = (inserted as { meta?: { changes?: number } }).meta?.changes;
      return changes === 1 ? { ok: true } : refuse(404, "That setting was just changed. Reload the page.");
    },
  };
}

export type { SettingValue };
