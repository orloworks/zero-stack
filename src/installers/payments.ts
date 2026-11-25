import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorError, editFile, editJson, needKey, replaceAnchor } from "../anchor";
import type { Config } from "../flags";
import { ADMIN_TEST_DEV_DEPS, PAYMENTS_DEPS } from "../versions";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/payments/svelte");
const ACCOUNT = "pages/settings.svelte";

// --payments on svelte: the plan declaration, the Stripe client, the billing module, the Billing page, the example gated route, the sandbox seed
// script and the tests. The auth.ts, env.ts and .env parts come from the composers; the plugin's tables reach the migration through `void db generate`.
export function installPayments(dir: string, config: Pick<Config, "admin">): void {
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
  if (config.admin) installPaymentsAdmin(dir);
}

const ACCESS = "src/access.ts";
const FEATURES_DECL = "src/app/features.ts";
const ACCESS_TEST = "tests/access.test.ts";
const FEATURES_SERVER = "pages/admin/features.server.ts";
const FEATURES_PAGE = "pages/admin/features.svelte";
const USER_SERVER = "pages/admin/users/[id].server.ts";
const USER_PAGE = "pages/admin/users/[id].svelte";

// --payments with --admin (#85): plan-gated feature switches and a read-only Billing section on the admin user page. Runs after installAdmin and installPayments.
function installPaymentsAdmin(dir: string): void {
  cpSync(join(here, "../admin"), dir, { recursive: true, force: false, errorOnExist: true });
  // PLAN_FEATURES is declared in the app's features file (#105), after FEATURES.
  editFile(dir, FEATURES_DECL, (s) =>
    replaceAnchor(
      s,
      'export const FEATURES = ["example-feature"] as const;\n',
      `export const FEATURES = ["example-feature"] as const;

// Which plans each feature is on for: feature name to plan names (lowercase, each a plan declared in src/app/plans.ts). A user on a listed plan has the feature
// on, unless the kill switch or their own setting says otherwise. The scaffold's example turns example-feature on for pro: replace it, or empty the object.
export const PLAN_FEATURES: Partial<Record<(typeof FEATURES)[number], readonly string[]>> = { "example-feature": ["pro"] };
`,
      FEATURES_DECL,
    ),
  );
  // The one plan source, in access.ts's empty `sources` slot. The precedence (kill switch, per-user override, plan, global) is already in decide().
  editFile(dir, ACCESS, (s) => {
    s = replaceAnchor(s, 'import { FEATURES } from "./app/features";\n', 'import { FEATURES, PLAN_FEATURES } from "./app/features";\n', ACCESS);
    return replaceAnchor(
      s,
      "// Where plans grant features. Empty until --payments adds a source: each returns the features a user's plan includes.\nconst sources: ((userId: string) => Promise<ReadonlySet<Feature>>)[] = [];\n",
      `// Where plans grant features: PLAN_FEATURES (declared in src/app/features.ts) names, per feature, the plans it is on for. billing is imported on use, like the
// database: Void loads auth.ts at startup.
export { PLAN_FEATURES };
export const featuresForPlan = (plan: string | null): ReadonlySet<Feature> =>
  new Set(plan ? FEATURES.filter((f) => PLAN_FEATURES[f]?.some((p) => p.toLowerCase() === plan.toLowerCase())) : []);
const sources: ((userId: string) => Promise<ReadonlySet<Feature>>)[] = [async (userId) => featuresForPlan(await (await import("./billing")).currentPlan(userId))];
`,
      ACCESS,
    );
  });
  editFile(dir, ACCESS_TEST, (s) =>
    replaceAnchor(s, '["FEATURES", "adminSwitches", "decide", "features", "requireFeature"]', '["FEATURES", "PLAN_FEATURES", "adminSwitches", "decide", "features", "featuresForPlan", "requireFeature"]', ACCESS_TEST),
  );
  // Features page: say, in words, when a feature is on through a plan.
  editFile(dir, FEATURES_SERVER, (s) => {
    s = replaceAnchor(s, "import { adminSwitches, FEATURES } from", "import { adminSwitches, FEATURES, PLAN_FEATURES } from", FEATURES_SERVER);
    return replaceAnchor(s, '({ name, state: global[name] ?? ("off" as const) })', '({ name, state: global[name] ?? ("off" as const), plans: PLAN_FEATURES[name] ?? [] })', FEATURES_SERVER);
  });
  editFile(dir, FEATURES_PAGE, (s) =>
    replaceAnchor(
      s,
      "        </fieldset>\n",
      '        </fieldset>\n        {#if f.plans.length}<p class="hint">Also on for users on the {f.plans.join(" or ")} plan, unless the kill switch or their own setting says otherwise.</p>{/if}\n',
      FEATURES_PAGE,
    ),
  );
  // User page: a read-only Billing section. No refund or plan-change buttons: those happen in the Stripe dashboard.
  editFile(dir, USER_SERVER, (s) => {
    s = replaceAnchor(s, 'import { adminSwitches, FEATURES } from "../../../src/access";\n', 'import { adminSwitches, FEATURES } from "../../../src/access";\nimport { adminBilling } from "../../../src/admin-billing";\n', USER_SERVER);
    s = replaceAnchor(s, "  const sw = await adminSwitches(c, user.id);\n", "  const sw = await adminSwitches(c, user.id);\n  const billing = await adminBilling(user.id, env.STRIPE_SECRET_KEY);\n", USER_SERVER);
    return replaceAnchor(s, "    features: FEATURES.map(", "    billing,\n    features: FEATURES.map(", USER_SERVER);
  });
  editFile(dir, USER_PAGE, (s) => {
    s = replaceAnchor(s, "onboarding, features, back }", "onboarding, features, billing, back }", USER_PAGE);
    return replaceAnchor(
      s,
      '<section aria-labelledby="features-title">\n',
      `<section aria-labelledby="billing-title">
  <h2 id="billing-title">Billing</h2>
  {#if !billing.status}
    <p>No subscription.</p>
  {:else}
    <dl>
      <dt>Plan</dt>
      <dd>{billing.plan}</dd>
      <dt>Status</dt>
      <dd>{billing.status}</dd>
    </dl>
  {/if}
  {#if billing.customerUrl}
    <p><a href={billing.customerUrl} target="_blank" rel="noopener noreferrer">View customer in Stripe (opens in a new tab)</a></p>
  {:else}
    <p class="hint">No Stripe customer yet: they have not started a checkout.</p>
  {/if}
</section>

<section aria-labelledby="features-title">
`,
      USER_PAGE,
    );
  });
}
