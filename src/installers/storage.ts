import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import type { Config } from "../flags";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/storage");

// --storage is server-only and framework-agnostic; validateFlags makes it imply --auth, so the routes are always auth-gated. The purge on account deletion is composed into auth.ts (composeAuthTs).
export function installStorage(dir: string, config: Config): void {
  cpSync(join(here, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(here, "tests"), join(dir, "tests"), { recursive: true });
  cpSync(join(here, "routes"), join(dir, "routes"), { recursive: true });
  // An upload that finishes after its user was deleted leaves a file nothing sweeps (E16): where an account can be deleted (both svelte-only), check the user row after the put.
  if (!config.accountDeletion && !config.admin) return;
  cpSync(join(here, "guard"), dir, { recursive: true, force: false, errorOnExist: true });
  const route = "routes/api/files/[name].ts";
  editFile(dir, route, (s) => {
    s = replaceAnchor(s, 'import { userKey } from "../../../src/storage";\n', 'import { userKey } from "../../../src/storage";\nimport { discardIfUserGone, userExists } from "../../../src/upload-guard";\n', route);
    s = replaceAnchor(s, 'export const PUT = defineHandler(async (c) => {\n  const key = userKey(requireAuth(c).id, c.req.param("name") ?? "");', 'export const PUT = defineHandler(async (c) => {\n  const user = requireAuth(c);\n  const key = userKey(user.id, c.req.param("name") ?? "");', route);
    return replaceAnchor(s, '  return new Response(null, { status: 201 });\n', '  if (await discardIfUserGone(key, () => userExists(user.id), storage)) return new Response("This account was deleted.", { status: 404 });\n  return new Response(null, { status: 201 });\n', route);
  });
}
