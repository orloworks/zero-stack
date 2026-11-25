import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Config, validateFlags } from "./flags";
import { type BaseCopy, badPath, bytesOf, FORMAT_VERSION, type Manifest, RECORD_DIR, UPGRADE_TMP } from "./manifest";
import { type Run, run, scaffold } from "./pipeline";
import { onTerminate } from "./children";
import { editInstead, scaffoldOwned } from "./ownership";

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

type Plan = { path: string; line: string; write?: { bytes: Buffer; mode?: number }; remove?: true; conflict?: true; edited?: true };

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
// A path may be acted on only when its nearest existing parent folder is where its own name says, with no symlink anywhere on the way: a link
// can lead out of the app, or make two recorded paths the same file.
function inside(dir: string, root: string, abs: string): boolean {
  let p = dirname(abs);
  while (!existsSync(p) && !isLink(p)) p = dirname(p);
  try {
    return realpathSync(p) === join(root, relative(dir, p));
  } catch {
    return false; // a dangling link
  }
}
const refuseBad = (keys: string[]) => {
  const bad = keys.find(badPath);
  if (bad) throw new Error(`refusing the path ${JSON.stringify(bad)}: it is not a file of the app's own tree`);
  // Two paths that differ only by case are one file on macOS and Windows: acting on both could delete what was just written.
  const seen = new Map<string, string>();
  for (const k of keys) {
    const twin = seen.get(k.toLowerCase());
    if (twin !== undefined && twin !== k) throw new Error(`refusing the paths ${JSON.stringify(twin)} and ${JSON.stringify(k)}: they differ only by case, so one file on macOS and Windows`);
    seen.set(k.toLowerCase(), k);
  }
};

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
function decide(dir: string, root: string, scratch: string, path: string, base: BaseCopy[string] | undefined, next: BaseCopy[string] | undefined, labels: string[]): Plan | null {
  const abs = join(dir, path);
  if (!inside(dir, root, abs)) return { path, line: `kept ${path} (outside your app)`, conflict: true };
  // lstat: a symlink at the path itself (dangling or not) is not a file, and nothing may be written through it.
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(abs);
  } catch (e) {
    if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; // ENOTDIR: a parent is a file, so the path is free of a file
  }
  if (stat && !stat.isFile()) return next ? { path, line: `kept ${path} (not a file in your app)`, conflict: true } : null;
  const mine = stat ? readFileSync(abs) : null;
  const was = base && bytesOf(base);
  const now = next && bytesOf(next);
  if (!now) return !mine || !was ? null : mine.equals(was) ? { path, line: `removed ${path}`, remove: true } : { path, line: `kept ${path} (removed in the new version, but you edited it)`, edited: true };
  // Only a replaced or added file takes the new version's mode; a merged one keeps the app's.
  const put = (bytes: Buffer, line: string, conflict?: true, chmod = false): Plan => ({ path, line, write: { bytes, mode: chmod ? next!.mode : undefined }, conflict });
  if (!mine) return base && was!.equals(now) ? null : base ? { path, line: `skipped ${path} (you deleted it; the new version changed it)` } : put(now, `added ${path}`, undefined, true);
  if (was?.equals(now) || mine.equals(now)) return null;
  if (was?.equals(mine)) return put(now, `replaced ${path}`, undefined, true);
  if (base?.encoding === "base64" || next.encoding === "base64" || !Buffer.from(mine.toString("utf8"), "utf8").equals(mine))
    return { path, line: `kept ${path} (binary, changed on both sides)`, conflict: true, edited: true };
  const m = merge(scratch, path, mine, was ?? Buffer.alloc(0), now, labels);
  return { ...put(m.bytes, `${m.conflict ? "CONFLICT" : "merged"} ${path}`, m.conflict ? true : undefined), edited: true };
}

const readRecord = (dir: string): { manifest: Manifest; base: BaseCopy } | null => {
  const m = join(dir, RECORD_DIR, "manifest.json"), b = join(dir, RECORD_DIR, "base.json");
  return existsSync(m) && existsSync(b) ? { manifest: JSON.parse(readFileSync(m, "utf8")), base: JSON.parse(readFileSync(b, "utf8")) } : null;
};

// Upgrades the app in `dir` to the running version; returns the exit code (1 when a conflict is left). Refusals throw before anything changes.
export async function upgrade(dir: string, log: (line: string) => void = console.log, scaffoldNext: (config: Config, target: string) => Promise<void> = (c, t) => scaffold(c, t, nestedRun)): Promise<number> {
  const root = realpathSync(dir);
  // A linked record folder would send the record, and the folder's removal, somewhere else.
  for (const p of [RECORD_DIR, UPGRADE_TMP, `${RECORD_DIR}/manifest.json`, `${RECORD_DIR}/base.json`]) if (isLink(join(dir, p))) throw new Error(`${p} is a symbolic link: replace it with a real folder first.`);
  const old = readRecord(dir);
  if (!old) throw new Error(`no ${RECORD_DIR}/manifest.json here: this app was made before apps recorded one, or with react, vue or solid. Port it once, or upgrade by hand: ${GUIDE}`);
  if (old.manifest.formatVersion !== FORMAT_VERSION) throw new Error(`the manifest has format ${old.manifest.formatVersion}; this zero-stack reads format ${FORMAT_VERSION}. Run the zero-stack version that made it.`);
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout.toString().trim() !== "true") throw new Error("not a git work tree: run `git init` and commit your app first, so the upgrade can be undone.");
  if (git(dir, ["status", "--porcelain", "--untracked-files=all"]).stdout.toString().trim()) throw new Error("uncommitted or untracked changes: commit or stash them first, so the upgrade can be undone.");

  if (git(dir, ["config", "core.autocrlf"]).stdout.toString().trim() === "true") throw new Error("core.autocrlf is true, so every file differs from its recorded LF copy: run `git config core.autocrlf false` for this app first.");
  refuseBad(Object.keys(old.base)); // before the temporary scaffold exists
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
    refuseBad(paths);
    plans = paths.flatMap((p) => decide(dir, root, join(tmp, "merge"), p, old.base[p], next.base[p], labels) ?? []);
    // Everything is decided before the first write, so a merge error leaves the app untouched.
    try {
      for (const p of plans) {
        const abs = join(dir, p.path);
        if (p.remove) rmSync(abs);
        else if (p.write) {
          try {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, p.write.bytes);
            if (p.write.mode !== undefined) chmodSync(abs, p.write.mode);
          } catch (e) {
            if (!["ENOTDIR", "EISDIR", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
            p.line = `kept ${p.path} (its path is taken by a folder or file)`;
            p.conflict = true;
          }
        }
      }
      for (const f of ["manifest.json", "base.json"]) copyFileSync(join(fresh, RECORD_DIR, f), join(dir, RECORD_DIR, f));
    } catch (e) {
      throw new Error(`the upgrade stopped partway (${(e as Error).message}); undo with \`git checkout . && git clean -fd\``);
    }
  } finally {
    clean();
    dispose();
  }
  for (const p of plans) log(p.line);
  if (!plans.length) log("Nothing to do: your app is already current.");
  else {
    const n = (word: string) => plans.filter((p) => p.line.startsWith(word)).length;
    log(`Summary: ${n("replaced")} replaced, ${n("added")} added, ${n("removed")} removed, ${n("merged")} merged, ${plans.filter((p) => p.conflict).length} in conflict.`);
  }
  // An edit in a scaffold-owned file is a merge now and again at every upgrade: say where it belongs.
  for (const p of plans) if (p.edited && scaffoldOwned(p.path)) log(`You edited ${p.path}, which zero-stack owns. ${editInstead(p.path)}`);
  if (plans.some((p) => p.path === "package.json" && p.write)) log("package.json changed: run `bun install`.");
  if (old.manifest.migrations !== next.manifest.migrations) log("The schema changed: run `void db generate` and read the migration it writes before you deploy. Nothing was migrated.");
  if (plans.length) log("To undo this upgrade, run:\n  git checkout .\n  git clean -fd");
  return plans.some((p) => p.conflict) ? 1 : 0;
}
