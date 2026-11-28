import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, editJson, needKey, replaceAnchor } from "../anchor";
import { ADMIN_TEST_DEV_DEPS } from "../versions";
import type { Config } from "../flags";

const template = join(dirname(fileURLToPath(import.meta.url)), "../../template");
const here = join(template, "admin");
const ACCOUNT = "pages/settings.svelte";
const ACCOUNT_SERVER = "pages/settings.server.ts";

// With --invite-only, invites live in the database (E10): the invite table, src/invites.ts (inviteAllowed, add, revoke, send), the Invites page and its routes, their tests,
// and the real src/invite-state.ts over the base app's stub. The auth.ts swap to inviteAllowed and the optional SIGNUP_ALLOWLIST come from the composers.
function installInvites(dir: string): void {
  const src = join(here, "invite-only");
  cpSync(src, dir, { recursive: true, force: false, errorOnExist: true, filter: (f) => !f.endsWith("src/invite-state.ts") });
  cpSync(join(src, "src/invite-state.ts"), join(dir, "src/invite-state.ts"));
  editFile(dir, "db/schema.ts", (s) => replaceAnchor(s, 'export * from "./schema/admin";\n', 'export * from "./schema/admin";\nexport * from "./schema/invites";\n', "db/schema.ts"));
  const layout = "pages/admin/layout.svelte";
  editFile(dir, layout, (s) => replaceAnchor(s, '    { href: "/admin", label: "Users" },\n', '    { href: "/admin", label: "Users" },\n    { href: "/admin/invites", label: "Invites" },\n', layout));
}

// --admin on svelte: the admin module and guard, the schema, the pages, their tests, and edits at anchors in the Account page and the schema.
// The auth.ts and env.ts parts come from the composers; ADMIN_EMAILS in .env from authEnv. Runs after installAuth and installStorage (their pages and routes exist).
export function installAdmin(dir: string, config: Config): void {
  cpSync(join(here, "svelte"), dir, { recursive: true, force: false, errorOnExist: true });
  // tests/onboarding.test.ts and tests/invites-db.test.ts import these; declared so another install layout can't drop them.
  editJson(dir, "package.json", (pkg) => { Object.assign(needKey(pkg, "devDependencies", "package.json"), ADMIN_TEST_DEV_DEPS); });
  // The matcher behind ADMIN_EMAILS is the invite-only one (E5): one copy, one test.
  if (!config.inviteOnly) cpSync(join(template, "auth/invite-only/src/signup-allowlist.ts"), join(dir, "src/signup-allowlist.ts"));
  if (!config.inviteOnly) cpSync(join(template, "auth/invite-only/tests/signup-allowlist.test.ts"), join(dir, "tests/signup-allowlist.test.ts"));

  // The email test's second case signs up a real (unverified) user and asks for a reset: an invite-only admin app mails them a set-password link.
  if (config.inviteOnly) {
    const t = "tests/auth-email.test.ts";
    editFile(dir, t, (s) => replaceAnchor(s, "/email send failed \\(Reset your password\\)/", "/email send failed \\((Reset|Set) your password\\)/", t));
  }

  const layout = "pages/admin/layout.svelte";
  editFile(dir, layout, (s) => replaceAnchor(s, 'const APP_NAME = "__APP_NAME__";', `const APP_NAME = ${JSON.stringify(config.name)};`, layout));
  if (config.inviteOnly) editFile(dir, "src/admin.ts", (s) => replaceAnchor(s, "export const INVITE_ONLY = false;", "export const INVITE_ONLY = true;", "src/admin.ts"));

  // db/schema.ts is Void's; the admin tables live beside it and are re-exported so `@schema` and `void db generate` see them.
  editFile(dir, "db/schema.ts", (s) => replaceAnchor(s, 'import { integer, sqliteTable, text } from "void/schema-d1";\n', 'import { integer, sqliteTable, text } from "void/schema-d1";\n\nexport * from "./schema/admin";\n', "db/schema.ts"));
  if (config.inviteOnly) installInvites(dir); // after the schema edit it extends

  // Account page: an Admin link for admins and nothing for anyone else; it never says whether an unverified address is on the admin list (#153).
  editFile(dir, ACCOUNT_SERVER, (s) => {
    s = replaceAnchor(s, 'import { getUser } from "void/auth";\n', 'import { getUser } from "void/auth";\nimport { adminAccess } from "../src/admin";\n', ACCOUNT_SERVER);
    return replaceAnchor(s, "defineHandler(() => ({ user: getUser() }));", "defineHandler(() => {\n  const user = getUser();\n  return { user, admin: adminAccess(user) };\n});", ACCOUNT_SERVER);
  });
  editFile(dir, ACCOUNT, (s) => {
    s = replaceAnchor(s, "  let { user }: Props = $props();\n", "  let { user, admin }: Props = $props();\n", ACCOUNT);
    return replaceAnchor(s, "    <p>Signed in as {user.email}</p>\n", `    <p>Signed in as {user.email}</p>
    {#if admin === "admin"}
      <p><a href="/admin">Admin</a></p>
    {/if}
`, ACCOUNT);
  });
}
