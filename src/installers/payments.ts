import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorError, editFile, editJson, needKey, replaceAnchor } from "../anchor";
import { ADMIN_TEST_DEV_DEPS, PAYMENTS_DEPS } from "../versions";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/payments/svelte");
const ACCOUNT = "pages/settings.svelte";

// --payments on svelte: the plan declaration, the Stripe client, the billing module, the Billing page, the example gated route, the sandbox seed
// script and the tests. The auth.ts, env.ts and .env parts come from the composers; the plugin's tables reach the migration through `void db generate`.
export function installPayments(dir: string): void {
  cpSync(here, dir, { recursive: true, force: false, errorOnExist: true });
  editJson(dir, "package.json", (pkg) => {
    Object.assign(needKey(pkg, "dependencies", "package.json"), PAYMENTS_DEPS);
    Object.assign(needKey(pkg, "devDependencies", "package.json"), ADMIN_TEST_DEV_DEPS); // tests/billing.test.ts runs on in-memory SQLite
    Object.assign(needKey(pkg, "scripts", "package.json"), { "stripe:seed": "bun scripts/stripe-seed.ts" });
  });
  // create-void's tsconfig `include` lists directories, so tsc (verify) skips scripts/ unless it is added (--secrets may have added it already).
  editJson(dir, "tsconfig.json", (ts) => {
    if (!Array.isArray(ts.include)) throw anchorError("include", "tsconfig.json");
    if (!ts.include.includes("scripts")) ts.include.push("scripts");
  });
  editFile(dir, ACCOUNT, (s) => replaceAnchor(s, "    <p>Signed in as {user.email}</p>\n", '    <p>Signed in as {user.email}</p>\n    <p><a href="/billing">Billing</a></p>\n', ACCOUNT));
}
