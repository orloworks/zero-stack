import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/storage");

// --storage is server-only and framework-agnostic; validateFlags makes it imply --auth, so the routes are always auth-gated. The purge on account deletion is composed into auth.ts (composeAuthTs).
export function installStorage(dir: string): void {
  cpSync(join(here, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(here, "tests"), join(dir, "tests"), { recursive: true });
  cpSync(join(here, "routes"), join(dir, "routes"), { recursive: true });
}
