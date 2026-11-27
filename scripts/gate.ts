// Scaffold into a temp dir, then vp check/build/test, verify, db:reset, GET / against vp dev.
// Optional args choose the permutation: bun scripts/gate.ts [--framework vue] [--<feature flag from src/flags.ts>...] [--name x]
// This file is the entry: arguments, the temp folder, scaffold, the fixed ordered list of check modules (scripts/gate/checks/) and cleanup.
// The app under test is driven through the harness (scripts/gate/harness.ts); every check lives in a module.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv as featureArgv, FEATURE_LIST, validateFlags } from "../src/flags";
import { killChildren, onTerminate } from "../src/children";
import { preflight, run, scaffold } from "../src/pipeline";
import { CREATE_VOID } from "../src/versions";
import { adminChecks } from "./gate/checks/admin";
import { allowlistChecks } from "./gate/checks/allowlist";
import { authChecks, writeAuthFixtures } from "./gate/checks/auth";
import { firstDevChecks } from "./gate/checks/first-dev";
import { marketingChecks } from "./gate/checks/marketing";
import { paymentsChecks } from "./gate/checks/payments";
import { secretsChecks } from "./gate/checks/secrets";
import { scaffoldChecks, staticChecks } from "./gate/checks/static";
import { baselineGate, upgradeGate } from "./gate/checks/upgrade";
import { createHarness } from "./gate/harness";
import type { Ctx } from "./gate/shared";

const root = mkdtempSync(join(tmpdir(), "zs-gate-"));
const argv = process.argv.slice(2);
const arg = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
// Matches `--secrets infisical` and `--secrets=infisical` alike (the CLI accepts both).
const hasSeq = (seq: string[]) => argv.includes(seq.join("=")) || argv.some((_, i) => seq.every((t, j) => argv[i + j] === t));
const name = arg("--name") ?? "gate-app";
const app = join(root, name);
const vp = join(app, "node_modules/.bin/vp");

// SIGINT/SIGTERM: every child (steps, dev server) is killed and awaited, then the temp dir goes; exit 130/143.
onTerminate(() => rmSync(root, { recursive: true, force: true }), 10_000);

const step = (args: string[]) => run([vp, ...args], app);

try {
  preflight();
  const input = {
    name,
    framework: arg("--framework"),
    ...Object.fromEntries(FEATURE_LIST.map((f) => [f.key, hasSeq(featureArgv(f)) || undefined])),
  };
  const { config } = validateFlags(input);
  const ctx: Ctx = { config, app, root, name, vp, argv, h: createHarness({ app, vp, turnstile: !!config.turnstile, inviteOnly: !!config.inviteOnly }), step };
  if (hasSeq(["--baseline"])) { // gate-only flag (matrix entry svelte-upgrade-baseline): the baseline is scaffolded by its own code, not this tree's
    await baselineGate(ctx);
  } else {
    // One retry when create-void's own install fails (better-sqlite3 or esbuild install scripts die under load); scaffold deletes the half-made app first.
    await scaffold(config, app).catch((e: Error) => {
      // Only the create-void command itself, never an anchor error or a later step whose path happens to contain "create-void".
      if (!(e.message.startsWith(`${process.execPath} x create-void@${CREATE_VOID} `) && e.message.endsWith(" failed"))) throw e;
      console.error(`gate: retrying once after: ${e.message}`);
      return scaffold(config, app);
    });
    scaffoldChecks(ctx);
    if (hasSeq(["--upgrade"])) { // gate-only flag (matrix entry svelte-upgrade): the honesty test replaces the HTTP checks
      await upgradeGate(ctx);
      rmSync(root, { recursive: true, force: true }); // process.exit skips the finally below; nothing else is running
      process.exit(0);
    }
    // Pre-build writes: the auth checks need a plugin in the app's auth extension and a route (their text lives in checks/auth.ts), and both must be in
    // the app before `vp check` formats it and `vp build` bundles it.
    if (config.framework === "svelte" && config.auth) {
      writeAuthFixtures(app);
      await step(["check", "--fix"]);
    }
    await step(["check"]);
    await step(["build"]);
    // The check modules, in this order. The order is load-bearing: storage asserts the file store holds only its own file, admin expects audit counts
    // that payments would change, and secrets runs last because it leaves `.env` rewritten. The auth checks hand the invite-only users to the allowlist checks.
    await staticChecks(ctx);
    const { port } = await firstDevChecks(ctx);
    const invited = await authChecks(ctx, { port });
    await allowlistChecks(ctx, invited);
    await adminChecks(ctx);
    await paymentsChecks(ctx, { port });
    await marketingChecks(ctx); // its admin deletions add audit entries the admin checks count, and it restarts the dev server itself
    await secretsChecks(ctx);
  }
} catch (e) {
  console.error(`gate failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await killChildren(); // the dev server and anything still running
  try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`gate: could not remove ${root}: ${(e as Error).message}`); }
}
