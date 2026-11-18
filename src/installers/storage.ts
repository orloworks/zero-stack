import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../flags";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/storage");

// --storage is server-only and framework-agnostic. The helper and its test always ship; the HTTP routes only with --auth
// (D12: never an unauthenticated write endpoint). The purge on account deletion is composed into auth.ts (composeAuthTs).
export function installStorage(dir: string, config: Config): void {
  cpSync(join(here, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(here, "tests"), join(dir, "tests"), { recursive: true });
  if (config.auth) cpSync(join(here, "routes"), join(dir, "routes"), { recursive: true });
}
