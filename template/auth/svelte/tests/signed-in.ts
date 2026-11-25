// A verified, signed-in user for tests that call the running dev server: `const { headers } = await signedIn()`, then `fetch(url, { headers })`.
// It runs a test-only Better Auth instance with the library's `testUtils` plugin on the dev server's own local database, signed with the app's
// BETTER_AUTH_SECRET, so the session cookie it makes is accepted by the running app. No captcha, mail or network is involved (with or without Turnstile).
// Start `vp dev` first and pass its origin in DEV_URL. Nothing here is imported by the app, so no route or plugin of it exists in a deployed Worker:
// keep it that way, and never add `testUtils` to auth.ts or src/app/auth.ts.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils } from "better-auth/plugins";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "../.void/better-auth-schema";

const envValue = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(readFileSync(".env", "utf8"))?.[1]?.trim() ?? "";
const sqliteFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sqliteFiles(join(dir, e.name)) : e.name.endsWith(".sqlite") ? [join(dir, e.name)] : []));
const rand = () => Math.random().toString(36).slice(2, 10);

// The dev server's local database is the one miniflare file under .void with a `user` table; the dev server creates it on its first request.
function authDatabase(): string {
  for (const f of sqliteFiles(".void")) {
    const d = new Database(f, { readonly: true });
    try {
      if (d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'user'").get()) return f;
    } finally {
      d.close();
    }
  }
  throw new Error("no local database with a user table under .void: start `vp dev` and request any page once, then run the test with DEV_URL set");
}

let testAuth: ReturnType<typeof makeAuth> | undefined;
function makeAuth() {
  const db = drizzle(new Database(authDatabase()), { schema });
  return betterAuth({
    secret: envValue("BETTER_AUTH_SECRET"),
    baseURL: process.env.DEV_URL ?? "http://localhost:5173",
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    plugins: [testUtils()],
  });
}

// `admin: true` signs in a verified user the app's ADMIN_EMAILS list admits (the first entry: the exact address, or a fresh address on the listed domain).
// `email` picks the address instead. The same address again signs in the same user.
export async function signedIn(options: { admin?: boolean; email?: string } = {}) {
  const ctx = await (testAuth ??= makeAuth()).$context;
  let email = options.email;
  if (!email && options.admin) {
    const entry = envValue("ADMIN_EMAILS").split(/[\s,]+/)[0];
    if (!entry) throw new Error("signedIn({ admin: true }): ADMIN_EMAILS in .env is empty");
    email = entry.startsWith("@") ? `admin-${rand()}${entry}` : entry;
  }
  email ??= `user-${rand()}@signed-in.test`;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  const user = found
    ? await ctx.internalAdapter.updateUser(found.user.id, { emailVerified: true })
    : await ctx.test.saveUser(ctx.test.createUser({ email, emailVerified: true }));
  const { headers, cookies } = await ctx.test.login({ userId: user.id });
  return { headers, cookie: headers.get("cookie") ?? "", cookies, user: { id: user.id as string, email } };
}
