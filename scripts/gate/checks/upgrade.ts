// Module 8: the upgrade checks, which replace the HTTP checks (`--upgrade`, `--baseline`). They run `src/index.ts upgrade` from this working tree,
// so the path to it is built from this file's own location (scripts/gate/checks/).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BaseCopy, readTree, RECORD_DIR, UPGRADE_TMP } from "../../../src/manifest";
import { scaffoldOwned } from "../../../src/ownership";
import { run, scaffold } from "../../../src/pipeline";
import { UPGRADE_BASELINE } from "../../../src/versions";
import type { Ctx } from "../shared";

// The upgrade honesty test (#101, entry `svelte-upgrade`): an app that edits only its declaration file upgrades with no conflict and a green verify.
// It lives in a check module, not in a script of its own, because the ci:full cache hashes only gate.ts, every file under scripts/gate/ (checks/ included), and src/.
export async function upgradeGate(ctx: Ctx): Promise<void> {
  const { config, app, root, name } = ctx;
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: app, stdout: "pipe", stderr: "pipe" });
  const commit = (msg: string) => {
    sh(["git", "add", "-A"]);
    const r = sh(["git", "-c", "user.name=gate", "-c", "user.email=gate@example.com", "commit", "-q", "-m", msg]);
    if (r.exitCode !== 0) throw new Error(`git commit failed: ${r.stderr.toString()}`);
  };
  const record = join(app, ".zero-stack/base.json");
  const steps = join(app, "src/app/onboarding.ts");
  const settings = join(app, "src/app/settings.ts");
  const exampleRoute = join(app, "routes/api/example-settings.ts");
  commit("scaffold");

  // 1. Edit as an owner would: only the declaration file.
  const edited = readFileSync(steps, "utf8").replace('["example-step"]', '["signed-in-once", "invited-a-friend"]');
  if (!edited.includes("invited-a-friend")) throw new Error("src/app/onboarding.ts has no example step to edit");
  writeFileSync(steps, edited);
  // A setting renamed, and the example route that read it dropped, as an owner would.
  const editedSettings = readFileSync(settings, "utf8").replace('"example-text"', '"site-title"');
  if (!editedSettings.includes("site-title")) throw new Error("src/app/settings.ts has no example setting to edit");
  writeFileSync(settings, editedSettings);
  rmSync(exampleRoute);
  // A feature renamed (and the plan features keyed by it, when --payments is on), and the example route that gated on it dropped (#105).
  const featuresFile = join(app, "src/app/features.ts");
  const plansFile = join(app, "src/app/plans.ts");
  const plansExist = existsSync(plansFile);
  // With --payments the plan "pro" is renamed "basic" too (plans list, plan features), and the example route that gated on it dropped.
  const editedFeatures = readFileSync(featuresFile, "utf8").replaceAll('"example-feature"', '"early-access"').replace('["pro"]', plansExist ? '["basic"]' : '["pro"]');
  if (!editedFeatures.includes("early-access")) throw new Error("src/app/features.ts has no example feature to edit");
  writeFileSync(featuresFile, editedFeatures);
  const featureRoute = join(app, "routes/api/example-feature.ts");
  rmSync(featureRoute);
  // A second plan added to the plans list, and "pro" renamed "basic" (--payments only).
  const planRoute = join(app, "routes/api/example-plan.ts");
  const editedPlans = plansExist ? readFileSync(plansFile, "utf8").replace('name: "pro"', 'name: "basic"').replace("pro_monthly", "basic_monthly").replace(/,?\s*\] as const satisfies/, `,\n  {\n    name: "team",\n    label: "Team",\n    currency: "usd",\n    monthly: { lookupKey: "team_monthly", amount: 4000 },\n  },\n] as const satisfies`) : "";
  if (plansExist) {
    if (!editedPlans.includes("team_monthly") || !editedPlans.includes('name: "basic"') || !editedPlans.includes("basic_monthly") || !editedFeatures.includes('["basic"]')) throw new Error("src/app/plans.ts or src/app/features.ts has no plan to edit");
    writeFileSync(plansFile, editedPlans);
    rmSync(planRoute);
  }
  // A trusted origin added to the auth extension (#104), the only place an app edits for auth.
  const extension = join(app, "src/app/auth.ts");
  const editedExtension = readFileSync(extension, "utf8").replace("trustedOrigins: []", 'trustedOrigins: ["https://app.example"]');
  if (!editedExtension.includes("https://app.example")) throw new Error("src/app/auth.ts has no empty trustedOrigins list to edit");
  writeFileSync(extension, editedExtension);

  // 2. Make the app look older, four ways.
  const base: BaseCopy = JSON.parse(readFileSync(record, "utf8"));
  const [aged, dropped, stale, signIn] = ["src/mail.ts", "src/lib/setting-value.ts", "src/stale.ts", "pages/sign-in.svelte"] as const;
  for (const p of [aged, dropped, signIn]) if (!base[p]) throw new Error(`${p} is not in the base copy`);
  if (!scaffoldOwned(aged) || !scaffoldOwned(dropped) || scaffoldOwned(signIn)) throw new Error("the ownership rule changed under the gate scenario");
  const agedText = readFileSync(join(app, aged), "utf8") + "// an older version of this file\n";
  writeFileSync(join(app, aged), agedText); // a scaffold-owned file and its base entry, rewritten together
  base[aged] = { ...base[aged]!, content: agedText };
  rmSync(join(app, dropped)); // dropped with its base entry: new in the new version
  delete base[dropped];
  writeFileSync(join(app, stale), "export const stale = 1;\n"); // a file the new version no longer has
  base[stale] = { mode: 0o644, encoding: "utf8", content: "export const stale = 1;\n" };
  base[signIn] = { ...base[signIn]!, content: base[signIn]!.content + "<!-- older -->\n" }; // an app-owned base entry
  writeFileSync(record, JSON.stringify(base, null, 2) + "\n");
  commit("edit and age");

  const localConfig = sh(["git", "config", "--list", "--local"]).stdout.toString();
  // 3. Upgrade: exit 0, one line per changed file, nothing committed.
  const r = sh([process.execPath, join(import.meta.dir, "../../../src/index.ts"), "upgrade"]);
  const out = r.stdout.toString();
  console.log(out.trimEnd());
  if (r.exitCode !== 0) throw new Error(`upgrade exited ${r.exitCode}: ${r.stderr.toString()}`);
  for (const line of [`replaced ${aged}`, `added ${dropped}`, `removed ${stale}`]) if (!out.includes(line)) throw new Error(`upgrade output has no "${line}":\n${out}`);
  if (out.includes("CONFLICT")) throw new Error(`upgrade reported a conflict:\n${out}`);
  if (!/^Summary: .* 0 in conflict\.$/m.test(out) || !out.trimEnd().endsWith("git clean -fd")) throw new Error(`upgrade output lacks the summary or ends without the undo commands:\n${out}`);
  if (sh(["git", "log", "--oneline"]).stdout.toString().trim().split("\n").length !== 2) throw new Error("upgrade committed");
  if (existsSync(join(app, UPGRADE_TMP))) throw new Error("upgrade left its temporary folder");
  if (sh(["git", "diff", "--cached", "--name-only"]).stdout.toString().trim()) throw new Error("upgrade staged files");
  if (sh(["git", "config", "--list", "--local"]).stdout.toString() !== localConfig) throw new Error("upgrade changed the app's local git config");

  // 4. The scaffold-owned files equal a fresh scaffold's, the owner's edit is intact, and the record is what a fresh scaffold writes.
  const freshApp = join(root, "fresh", name);
  mkdirSync(join(root, "fresh"));
  await scaffold(config, freshApp);
  const ownedOf = (dir: string) => JSON.stringify(Object.entries(readTree(dir)).filter(([p]) => scaffoldOwned(p)));
  if (ownedOf(app) !== ownedOf(freshApp)) throw new Error("the upgraded app's scaffold-owned files differ from a fresh scaffold's");
  if (readFileSync(steps, "utf8") !== edited) throw new Error("the upgrade changed the owner's edit in src/app/onboarding.ts");
  if (readFileSync(settings, "utf8") !== editedSettings) throw new Error("the upgrade changed the owner's edit in src/app/settings.ts");
  if (readFileSync(extension, "utf8") !== editedExtension) throw new Error("the upgrade changed the owner's edit in src/app/auth.ts");
  if (readFileSync(featuresFile, "utf8") !== editedFeatures) throw new Error("the upgrade changed the owner's edit in src/app/features.ts");
  if (plansExist && readFileSync(plansFile, "utf8") !== editedPlans) throw new Error("the upgrade changed the owner's edit in src/app/plans.ts");
  if (existsSync(exampleRoute) || existsSync(featureRoute) || existsSync(planRoute)) throw new Error("the upgrade brought back an example route the owner dropped");
  for (const f of ["manifest.json", "base.json"])
    if (readFileSync(join(app, RECORD_DIR, f), "utf8") !== readFileSync(join(freshApp, RECORD_DIR, f), "utf8")) throw new Error(`${RECORD_DIR}/${f} differs from a fresh scaffold's`);
  for (const [p, e] of Object.entries(readTree(app))) if (e.encoding === "utf8" && /^(<{7} |>{7} )/m.test(e.content)) throw new Error(`conflict markers in ${p}`);

  // 5. And it still verifies.
  await run([process.execPath, "run", "verify"], app);
  // 6. With --payments: every list emptied (the example routes are already gone) still verifies. Feature, plan and plan-feature types are `never` then, so scaffold-owned
  // code must not index or call through them (#105, fix round 1).
  if (plansExist) {
    const fs = (f: string, edit: (s: string) => string) => writeFileSync(join(app, f), edit(readFileSync(join(app, f), "utf8")));
    fs("src/app/features.ts", (s) => s.replace(/export const FEATURES = \[[^\]]*\] as const;/, "export const FEATURES = [] as const;").replace(/(export const PLAN_FEATURES[^=]*= )\{[^]*?\};/, "$1{};"));
    fs("src/app/plans.ts", (s) => s.replace(/export const PLANS = \[[^]*?\] as const/, "export const PLANS = [] as const"));
    const emptied = readFileSync(join(app, "src/app/features.ts"), "utf8") + readFileSync(join(app, "src/app/plans.ts"), "utf8");
    for (const want of ["FEATURES = [] as const", "= {};", "PLANS = [] as const"]) if (!emptied.includes(want)) throw new Error(`the gate could not empty a list: no "${want}" after the edit`);
    await run([process.execPath, "x", "vp", "check", "--fix"], app); // formatting only; the empty lists are what verify must accept
    await run([process.execPath, "run", "verify"], app);
    console.log("gate: with the features, plan features and plans lists emptied, verify passes");
  }
  console.log("gate: upgrade replaced, added and removed what an older app needed, kept the owner's edits (declarations and auth extension), matches a fresh scaffold, and verify passes");
}

// The cross-version honesty test (#102, entry `svelte-upgrade-baseline`): scaffold the pinned baseline from GitHub, edit only a declaration file it already
// had, upgrade with this working tree's code, and expect no conflict and a green verify. A failed fetch throws; it is never a pass.
export async function baselineGate(ctx: Ctx): Promise<void> {
  const { app, root, name, argv } = ctx;
  const sh = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: app, stdout: "pipe", stderr: "pipe" });
  const flags = argv.filter((a, i) => !["--baseline", "--name"].includes(a) && argv[i - 1] !== "--name");
  const made = Bun.spawnSync([process.execPath, "x", `github:orloworks/zero-stack#${UPGRADE_BASELINE}`, name, ...flags], { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
  if (made.exitCode !== 0 || !existsSync(join(app, RECORD_DIR, "manifest.json")))
    throw new Error(`could not scaffold the baseline github:orloworks/zero-stack#${UPGRADE_BASELINE} (is GitHub reachable?): ${made.stderr.toString().trim().slice(-600)}`);
  const commit = (msg: string) => {
    sh(["git", "add", "-A"]);
    if (sh(["git", "-c", "user.name=gate", "-c", "user.email=gate@example.com", "commit", "-q", "-m", msg]).exitCode !== 0) throw new Error("git commit failed");
  };
  commit("baseline");
  const steps = join(app, "src/app/onboarding.ts"); // the declaration file the baseline had
  const edited = readFileSync(steps, "utf8").replace('["example-step"]', '["signed-in-once", "invited-a-friend"]');
  if (!edited.includes("invited-a-friend")) throw new Error("the baseline's src/app/onboarding.ts has no example step to edit");
  writeFileSync(steps, edited);
  commit("edit");

  const r = sh([process.execPath, join(import.meta.dir, "../../../src/index.ts"), "upgrade"]);
  const out = r.stdout.toString();
  console.log(out.trimEnd());
  if (r.exitCode !== 0) throw new Error(`upgrade exited ${r.exitCode}: ${r.stderr.toString()}`);
  if (!/^(replaced|added|removed|merged) /m.test(out)) throw new Error(`the upgrade changed nothing, so the baseline ${UPGRADE_BASELINE.slice(0, 7)} is too new to prove anything (set UPGRADE_BASELINE to an older commit or tag):\n${out}`);
  if (out.includes("CONFLICT") || !/^Summary: .* 0 in conflict\.$/m.test(out)) throw new Error(`upgrade reported a conflict or no summary:\n${out}`);
  if (readFileSync(steps, "utf8") !== edited) throw new Error("the upgrade changed the owner's edit in src/app/onboarding.ts");
  for (const [p, e] of Object.entries(readTree(app))) if (e.encoding === "utf8" && /^(<{7} |>{7} )/m.test(e.content)) throw new Error(`conflict markers in ${p}`);
  if (out.includes("package.json changed")) await run([process.execPath, "install"], app);
  await run([process.execPath, "run", "verify"], app);
  console.log(`gate: upgrade from baseline ${UPGRADE_BASELINE.slice(0, 7)} kept the owner's edit with no conflict, and verify passes`);
}
