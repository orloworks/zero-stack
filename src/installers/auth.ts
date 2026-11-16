import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";
import { addPaths } from "./shared";
import type { Framework } from "../flags";

// Runs after installShadcn. Pages are copied; `void db generate` runs later in the pipeline (needs deps).
export function installAuth(dir: string, framework: Framework): void {
  const slice = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth", framework);
  editFile(dir, "void.config.ts", (s) =>
    replaceAnchor(s, "export default defineConfig({", 'export default defineConfig({\n  "auth": { "providers": ["email"] },', "void.config.ts"),
  );

  addPaths(dir, { "@auth-schema": ["./.void/better-auth-schema.ts"] });

  cpSync(join(slice, "pages"), join(dir, "pages"), { recursive: true });

  const gi = join(dir, ".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8").split("\n") : [];
  if (!lines.includes(".env")) appendFileSync(gi, (lines.at(-1) === "" || !lines.length ? "" : "\n") + ".env\n");
  writeFileSync(
    join(dir, ".env"),
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\nBETTER_AUTH_URL=http://localhost:5173\n`,
    { mode: 0o600 },
  );
}
