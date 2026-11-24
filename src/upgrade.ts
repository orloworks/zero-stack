import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type Config, validateFlags } from "./flags";
import { type BaseCopy, bytesOf, FORMAT_VERSION, type Manifest, RECORD_DIR, UPGRADE_TMP } from "./manifest";
import { type Run, run, scaffold } from "./pipeline";
import { onTerminate } from "./children";

const GUIDE = "https://github.com/orloworks/zero-stack/blob/main/docs/upgrading.md";
const git = (cwd: string, args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

// vp reads .gitignore files from every parent folder, and the app's own ignores this nested app, so its formatter would find nothing to format. An empty
// .git folder marks a repository boundary for that one step; it is removed straight after (the base copy skips it anyway).
const nestedRun: Run = async (cmd, cwd) => {
  const marker = join(cwd, ".git");
  const mark = cmd[0]!.endsWith("/vp") && !existsSync(marker);
  if (mark) mkdirSync(marker);
  try {
    await run(cmd, cwd);
  } finally {
    if (mark) rmSync(marker, { recursive: true, force: true });
  }
};

type Plan = { path: string; line: string; write?: { bytes: Buffer; mode: number }; remove?: true; conflict?: true };

// Three-way merge of one text file with git's own file merge. Exit code: conflict count (capped at 127); anything above is an error.
function merge(scratch: string, path: string, mine: Buffer, base: Buffer, theirs: Buffer, labels: string[]): { bytes: Buffer; conflict: boolean } {
  mkdirSync(scratch, { recursive: true });
  const [a, b, c] = ["mine", "base", "theirs"].map((n) => join(scratch, n));
  writeFileSync(a!, mine);
  writeFileSync(b!, base);
  writeFileSync(c!, theirs);
  const r = git(scratch, ["merge-file", ...labels.flatMap((l) => ["-L", l]), a!, b!, c!]);
  if (r.exitCode === null || r.exitCode > 127) throw new Error(`git merge-file failed on ${path}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
  return { bytes: readFileSync(a!), conflict: r.exitCode > 0 };
}

// What to do with one path, from the app's file (null: none), its base entry (null: none) and the new version's entry (null: none).
function decide(dir: string, scratch: string, path: string, base: BaseCopy[string] | undefined, next: BaseCopy[string] | undefined, labels: string[]): Plan | null {
  const abs = join(dir, path);
  const stat = existsSync(abs) ? lstatSync(abs) : null;
  if (stat && !stat.isFile()) return next ? { path, line: `kept ${path} (not a file in your app)` } : null;
  const mine = stat ? readFileSync(abs) : null;
  const was = base && bytesOf(base);
  const now = next && bytesOf(next);
  if (!now) return !mine || !was ? null : mine.equals(was) ? { path, line: `removed ${path}`, remove: true } : { path, line: `kept ${path} (removed in the new version, but you edited it)` };
  const put = (bytes: Buffer, line: string, conflict?: true): Plan => ({ path, line, write: { bytes, mode: next!.mode }, conflict });
  if (!mine) return base && was!.equals(now) ? null : base ? { path, line: `skipped ${path} (you deleted it; the new version changed it)` } : put(now, `added ${path}`);
  if (was?.equals(now) || mine.equals(now)) return null;
  if (was?.equals(mine)) return put(now, `replaced ${path}`);
  if (base?.encoding === "base64" || next.encoding === "base64" || !Buffer.from(mine.toString("utf8"), "utf8").equals(mine))
    return { path, line: `kept ${path} (binary, changed on both sides)` };
  const m = merge(scratch, path, mine, was ?? Buffer.alloc(0), now, labels);
  return put(m.bytes, `${m.conflict ? "CONFLICT" : "merged"} ${path}`, m.conflict ? true : undefined);
}

const readRecord = (dir: string): { manifest: Manifest; base: BaseCopy } | null => {
  const m = join(dir, RECORD_DIR, "manifest.json"), b = join(dir, RECORD_DIR, "base.json");
  return existsSync(m) && existsSync(b) ? { manifest: JSON.parse(readFileSync(m, "utf8")), base: JSON.parse(readFileSync(b, "utf8")) } : null;
};

// Upgrades the app in `dir` to the running version; returns the exit code (1 when a conflict is left). Refusals throw before anything changes.
export async function upgrade(dir: string, log: (line: string) => void = console.log, scaffoldNext: (config: Config, target: string) => Promise<void> = (c, t) => scaffold(c, t, nestedRun)): Promise<number> {
  const old = readRecord(dir);
  if (!old) throw new Error(`no ${RECORD_DIR}/manifest.json here: this app was made before apps recorded one, or with react, vue or solid. Port it once, or upgrade by hand: ${GUIDE}`);
  if (old.manifest.formatVersion !== FORMAT_VERSION) throw new Error(`the manifest has format ${old.manifest.formatVersion}; this zero-stack reads format ${FORMAT_VERSION}. Run the zero-stack version that made it.`);
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout.toString().trim() !== "true") throw new Error("not a git work tree: run `git init` and commit your app first, so the upgrade can be undone.");
  if (git(dir, ["status", "--porcelain", "--untracked-files=all"]).stdout.toString().trim()) throw new Error("uncommitted or untracked changes: commit or stash them first, so the upgrade can be undone.");

  const tmp = join(dir, UPGRADE_TMP);
  const { config } = validateFlags(old.manifest.config); // a hand-edited manifest still gets the name and flag rules
  const fresh = join(tmp, config.name);
  const clean = () => rmSync(tmp, { recursive: true, force: true });
  clean(); // a leftover from a killed run
  const dispose = onTerminate(clean);
  let plans: Plan[];
  let next: { manifest: Manifest; base: BaseCopy };
  try {
    mkdirSync(tmp, { recursive: true });
    await scaffoldNext(config, fresh);
    const made = readRecord(fresh);
    if (!made) throw new Error(`the new version wrote no ${RECORD_DIR}/ record`);
    next = made;
    const labels = ["your app", `zero-stack ${old.manifest.zeroStack} (your last upgrade)`, `zero-stack ${next.manifest.zeroStack} (new)`];
    const paths = [...new Set([...Object.keys(old.base), ...Object.keys(next.base)])].sort();
    // Paths come from files the app can edit: never act outside the app's folder.
    const bad = paths.find((p) => isAbsolute(p) || p.split("/").includes(".."));
    if (bad) throw new Error(`refusing the path ${JSON.stringify(bad)}: it leaves the app's folder`);
    plans = paths.flatMap((p) => decide(dir, join(tmp, "merge"), p, old.base[p], next.base[p], labels) ?? []);
    // Everything is decided before the first write, so a merge error leaves the app untouched.
    for (const p of plans) {
      const abs = join(dir, p.path);
      if (p.remove) rmSync(abs);
      else if (p.write) {
        try {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, p.write.bytes);
          chmodSync(abs, p.write.mode);
        } catch (e) {
          if (!["ENOTDIR", "EISDIR", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
          p.line = `kept ${p.path} (its path is taken by a folder or file)`;
          p.conflict = undefined;
        }
      }
    }
    for (const f of ["manifest.json", "base.json"]) copyFileSync(join(fresh, RECORD_DIR, f), join(dir, RECORD_DIR, f));
  } finally {
    clean();
    dispose();
  }
  for (const p of plans) log(p.line);
  if (!plans.length) log("Already current: no files changed.");
  if (old.manifest.migrations !== next.manifest.migrations) log("The schema changed: run `void db generate` and read the migration it writes before you deploy. Nothing was migrated.");
  return plans.some((p) => p.conflict) ? 1 : 0;
}
