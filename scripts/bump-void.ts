// Keeps the create-void pin on the latest release.
//   bun scripts/bump-void.ts          rewrite src/versions.ts to the latest create-void and print what moved underneath
//   bun scripts/bump-void.ts --check  print one line when a newer create-void is out; never fails, silent when offline
// A bump still needs `bun run ci:full` and a review (plus /cso when better-auth moved) before it merges.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREATE_VOID } from "../src/versions";

const VERSIONS = join(import.meta.dir, "../src/versions.ts");
const DEPS_LINE = /export const ADMIN_TEST_DEV_DEPS = \{[^}]*\};/;

const replaceOnce = (s: string, from: string, to: string): string => {
  if (s.split(from).length !== 2) throw new Error(`expected exactly one "${from}" in src/versions.ts`);
  return s.replace(from, to);
};

// The new versions.ts text: the pin, and the --admin test packages on void's own ranges (so one copy installs).
export function bumpVersions(src: string, from: string, to: string, voidDeps: Record<string, string>): string {
  let out = replaceOnce(src, `CREATE_VOID = "${from}"`, `CREATE_VOID = "${to}"`);
  out = replaceOnce(out, `same ranges as void@${from}`, `same ranges as void@${to}`);
  const line = out.match(DEPS_LINE)?.[0];
  if (!line) throw new Error("ADMIN_TEST_DEV_DEPS not found in src/versions.ts");
  const names = [...line.matchAll(/"([^"]+)":/g)].map((m) => m[1]);
  const deps = names.map((n) => {
    if (!voidDeps[n]) throw new Error(`void@${to} no longer depends on ${n}; check the --admin tests`);
    return `${JSON.stringify(n)}: ${JSON.stringify(voidDeps[n])}`;
  });
  return out.replace(DEPS_LINE, `export const ADMIN_TEST_DEV_DEPS = { ${deps.join(", ")} };`);
}

// Dependencies whose range changed between two void releases, better-auth first (it decides whether /cso runs).
export function depChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => Number(b === "better-auth") - Number(a === "better-auth") || a.localeCompare(b));
  return names.filter((n) => before[n] !== after[n]).map((n) => `${n}: ${before[n] ?? "(none)"} -> ${after[n] ?? "(removed)"}`);
}

const get = async (path: string): Promise<any> => {
  const r = await fetch(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`npm registry ${path}: ${r.status}`);
  return r.json();
};

if (import.meta.main) {
  const check = process.argv.includes("--check");
  try {
    const latest: string = (await get("create-void/latest")).version;
    if (latest === CREATE_VOID) {
      if (!check) console.log(`create-void ${CREATE_VOID} is already the latest.`);
    } else if (check) {
      console.log(`note: create-void ${latest} is out; the pin is ${CREATE_VOID}. Run: bun scripts/bump-void.ts`);
    } else {
      const [before, after] = await Promise.all([get(`void/${CREATE_VOID}`), get(`void/${latest}`)]);
      writeFileSync(VERSIONS, bumpVersions(readFileSync(VERSIONS, "utf8"), CREATE_VOID, latest, after.dependencies ?? {}));
      console.log(`Pinned create-void ${latest} (was ${CREATE_VOID}).`);
      const changes = depChanges(before.dependencies ?? {}, after.dependencies ?? {});
      console.log(changes.length ? `void dependencies that moved:\n  ${changes.join("\n  ")}` : "No void dependency ranges moved.");
      if (changes.some((c) => c.startsWith("better-auth:"))) console.log("better-auth moved: run /cso on the bump PR.");
      const stale = Bun.spawnSync(["git", "grep", "-l", "-E", `void@[0-9]`, "--", "docs/"], { cwd: join(import.meta.dir, "..") }).stdout.toString().trim();
      if (stale) console.log(`Docs that record facts checked against an older void (re-check what the bump touches):\n  ${stale.split("\n").join("\n  ")}`);
      console.log("Next: bun run ci:full, then a PR with a review.");
    }
  } catch (e) {
    if (!check) throw e; // --check never blocks a push: offline or a registry error stays silent
  }
}
