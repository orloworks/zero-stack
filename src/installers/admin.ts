import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
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
  editFile(dir, layout, (s) => replaceAnchor(s, '    { href: "/admin/audit", label: "Audit log" },\n', '    { href: "/admin/invites", label: "Invites" },\n    { href: "/admin/audit", label: "Audit log" },\n', layout));
}

// --admin on svelte: the admin module and guard, the schema, the pages, their tests, and edits at anchors in the Account page and the schema.
// The auth.ts and env.ts parts come from the composers; ADMIN_EMAILS in .env from authEnv. Runs after installAuth and installStorage (their pages and routes exist).
export function installAdmin(dir: string, config: Config): void {
  cpSync(join(here, "svelte"), dir, { recursive: true, force: false, errorOnExist: true });
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

  // Account page: an Admin link for admins, a verify hint for a listed owner whose email is not verified yet (D9).
  editFile(dir, ACCOUNT_SERVER, (s) => {
    s = replaceAnchor(s, 'import { getUser } from "void/auth";\n', 'import { getUser } from "void/auth";\nimport { adminAccess } from "../src/admin";\n', ACCOUNT_SERVER);
    return replaceAnchor(s, "defineHandler(() => ({ user: getUser() }));", "defineHandler(() => {\n  const user = getUser();\n  return { user, admin: adminAccess(user) };\n});", ACCOUNT_SERVER);
  });
  editFile(dir, ACCOUNT, (s) => {
    s = replaceAnchor(s, "  let { user }: Props = $props();\n", `  let { user, admin }: Props = $props();

  let verifying = $state(false);
  let verifyState = $state<"" | "requested" | "error">("");
  async function sendVerification() {
    if (!user) return;
    verifying = true;
    verifyState = "";
    try {
      const res = await auth.sendVerificationEmail({ email: user.email, callbackURL: "/settings" });
      verifyState = res.error ? "error" : "requested";
    } catch {
      verifyState = "error";
    } finally {
      verifying = false;
    }
  }
`, ACCOUNT);
    return replaceAnchor(s, "    <p>Signed in as {user.email}</p>\n", `    <p>Signed in as {user.email}</p>
    {#if admin === "admin"}
      <p><a href="/admin">Admin</a></p>
    {:else if admin === "unverified"}
      <p>Your email is on the admin list but isn't verified yet.</p>
      <button type="button" onclick={sendVerification} disabled={verifying}>{verifying ? "Sending…" : "Send verification link"}</button>
      {#if verifyState === "requested"}<p role="status">Verification link requested for {user.email}.</p>{/if}
      {#if verifyState === "error"}<p role="alert">Couldn't request the link. Try again.</p>{/if}
    {/if}
`, ACCOUNT);
  });

  // An upload that finishes after its user was deleted leaves a file nothing sweeps (E16): check the user row after the put.
  if (config.storage) {
    cpSync(join(here, "storage"), dir, { recursive: true, force: false, errorOnExist: true });
    const route = "routes/api/files/[name].ts";
    editFile(dir, route, (s) => {
      s = replaceAnchor(s, 'import { userKey } from "../../../src/storage";\n', 'import { userExists } from "../../../src/admin";\nimport { userKey } from "../../../src/storage";\nimport { discardIfUserGone } from "../../../src/upload-guard";\n', route);
      s = replaceAnchor(s, 'export const PUT = defineHandler(async (c) => {\n  const key = userKey(requireAuth(c).id, c.req.param("name") ?? "");', 'export const PUT = defineHandler(async (c) => {\n  const user = requireAuth(c);\n  const key = userKey(user.id, c.req.param("name") ?? "");', route);
      return replaceAnchor(s, '  return new Response(null, { status: 201 });\n', '  if (await discardIfUserGone(key, () => userExists(user.id), storage)) return new Response("This account was deleted.", { status: 404 });\n  return new Response(null, { status: 201 });\n', route);
    });
  }
}
