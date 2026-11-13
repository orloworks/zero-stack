import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceAnchor } from "../anchor";
import type { Framework } from "../flags";
import { CREATE_VOID } from "../versions";

// Void's generated mappings (.void/tsconfig.json), restored whenever we write `paths`.
const VOID_PATHS = {
  "void/db": ["./.void/db.d.ts"],
  "@schema": ["./db/schema.ts"],
  "@schema/*": ["./db/schema/*"],
  "void/routes": ["./.void/routes.d.ts"],
};

// Runs after installShadcn. Pages are copied; `void db generate` runs later in the pipeline (needs deps).
export function installAuth(dir: string, framework: Framework): void {
  const slice = join(dirname(fileURLToPath(import.meta.url)), "../../template/auth", framework);
  const config = join(dir, "void.config.ts");
  writeFileSync(
    config,
    replaceAnchor(
      readFileSync(config, "utf8"),
      "export default defineConfig({",
      'export default defineConfig({\n  "auth": { "providers": ["email"] },',
      "void.config.ts",
    ),
  );

  // A `paths` entry replaces the generated ones, so merge into whatever shadcn wrote (or add Void's four).
  const tsconfig = join(dir, "tsconfig.json");
  const ts = JSON.parse(readFileSync(tsconfig, "utf8"));
  if (!ts.compilerOptions) throw new Error(`tsconfig.json anchor missing: compilerOptions (create-void@${CREATE_VOID})`);
  ts.compilerOptions.paths = { ...(ts.compilerOptions.paths ?? VOID_PATHS), "@auth-schema": ["./.void/better-auth-schema.ts"] };
  writeFileSync(tsconfig, JSON.stringify(ts, null, 2) + "\n");

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
