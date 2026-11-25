import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateFlags } from "../../src/flags";
import { writeRecord } from "../../src/manifest";
import { upgrade } from "../../src/upgrade";
import { tmpMaker } from "./tmp";
const mkTmp = tmpMaker();

const config = validateFlags({ name: "app", framework: "svelte" }).config;
type Files = Record<string, string | Buffer | null>;

const put = (dir: string, files: Files) => {
  for (const [p, t] of Object.entries(files)) {
    if (t === null) rmSync(join(dir, p), { force: true });
    else {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
  }
};
const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");
const IGNORE = ".env\n.zero-stack/upgrade-tmp\n";

// An app that was generated from `old` (so its base copy is `old`), then edited by the owner (`edits`; null deletes), and committed.
function makeApp(old: Files, edits: Files = {}, { commit = true } = {}) {
  const dir = join(mkTmp("zs-up-"), "app");
  mkdirSync(join(dir, "node_modules"), { recursive: true }); // empty, so git ignores it; the upgrade refuses an app without one
  put(dir, { ".gitignore": IGNORE, ...old });
  writeRecord(dir, config);
  put(dir, edits);
  git(dir, "init", "-q");
  if (commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "app");
  }
  return dir;
}
// The fake scaffold of the new version: writes `next` into the target and records it, as the real pipeline does last.
const scaffoldOf = (next: Files) => async (c: typeof config, target: string) => {
  put(target, { ".gitignore": IGNORE, ...next });
  writeRecord(target, c);
};
async function runAll(dir: string, next: Files) {
  const lines: string[] = [];
  const code = await upgrade(dir, (l) => lines.push(l), scaffoldOf(next));
  return { code, lines };
}
// The per-file report, without the summary block (which has its own tests at the end).
async function run(dir: string, next: Files) {
  const r = await runAll(dir, next);
  return { code: r.code, lines: r.lines.filter((l) => !/^(Summary:|You edited |package\.json changed|To undo)/.test(l)) };
}
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("an untouched file is replaced by the new version, with the new file mode", async () => {
  const dir = makeApp({ "scripts/run.sh": "v1\n" });
  const r = await run(dir, { "scripts/run.sh": "v2\n" });
  expect(r).toEqual({ code: 0, lines: ["replaced scripts/run.sh"] });
  expect(read(dir, "scripts/run.sh")).toBe("v2\n");
  const next = { "scripts/run.sh": "v3\n" };
  chmodSync(join(dir, "scripts/run.sh"), 0o644);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "up");
  const exec = async (c: typeof config, t: string) => {
    put(t, { ".gitignore": IGNORE, ...next });
    chmodSync(join(t, "scripts/run.sh"), 0o755);
    writeRecord(t, c);
  };
  await upgrade(dir, () => {}, exec);
  expect(statSync(join(dir, "scripts/run.sh")).mode & 0o777).toBe(0o755);
});

test("a file unchanged upstream is left alone, even when the app edited it", async () => {
  const dir = makeApp({ "a.ts": "same\n" }, { "a.ts": "mine\n" });
  expect(await run(dir, { "a.ts": "same\n" })).toEqual({ code: 0, lines: ["Nothing to do: your app is already current."] });
  expect(read(dir, "a.ts")).toBe("mine\n");
});

test("changed on both sides and mergeable: merged, the app's edit kept; same for a scaffold-owned file", async () => {
  const files = { "pages/index.svelte": lines(5), "src/mail.ts": lines(5) };
  const mine = (t: string) => t.replace("line 1", "mine 1");
  const theirs = (t: string) => t.replace("line 5", "new 5");
  const dir = makeApp(files, { "pages/index.svelte": mine(lines(5)), "src/mail.ts": mine(lines(5)) });
  const r = await run(dir, { "pages/index.svelte": theirs(lines(5)), "src/mail.ts": theirs(lines(5)) });
  expect(r).toEqual({ code: 0, lines: ["merged pages/index.svelte", "merged src/mail.ts"] });
  for (const p of ["pages/index.svelte", "src/mail.ts"]) expect(read(dir, p)).toBe(mine(theirs(lines(5))));
});

test("both changed the same line: markers with readable labels, listed, exit 1; the record still moves forward", async () => {
  const dir = makeApp({ "a.ts": lines(3) }, { "a.ts": lines(3).replace("line 2", "mine") });
  const r = await run(dir, { "a.ts": lines(3).replace("line 2", "theirs") });
  expect(r).toEqual({ code: 1, lines: ["CONFLICT a.ts"] });
  const text = read(dir, "a.ts");
  expect(text).toMatch(/^<<<<<<< your app\nmine\n\|{0}=======\ntheirs\n>>>>>>> zero-stack \S+ \(new\)\n/m);
  expect(JSON.parse(read(dir, ".zero-stack/base.json"))["a.ts"].content).toBe(lines(3).replace("line 2", "theirs"));
});

test("a new file is written only when the path is free; a taken path is merged, never overwritten", async () => {
  const dir = makeApp({ "keep.ts": "k\n" }, { "taken.ts": "app's own\n" });
  const r = await run(dir, { "keep.ts": "k\n", "fresh.ts": "new\n", "taken.ts": "theirs\n" });
  expect(read(dir, "fresh.ts")).toBe("new\n");
  expect(r.lines).toContain("added fresh.ts");
  expect(read(dir, "taken.ts")).toContain("app's own");
  expect(r.code).toBe(1);
  expect(read(dir, "taken.ts")).toMatch(/^<<<<<<< your app\napp.s own\n=======\ntheirs\n>>>>>>> /m); // both versions, never overwritten
  expect(r.lines).toContain("CONFLICT taken.ts");
});

test("a file the new version removed is deleted only when untouched", async () => {
  const dir = makeApp({ "gone.ts": "g\n", "edited.ts": "e\n", "mine.ts": "m\n" }, { "edited.ts": "e!\n" });
  const r = await run(dir, { "mine.ts": "m\n" });
  expect(existsSync(join(dir, "gone.ts"))).toBe(false);
  expect(read(dir, "edited.ts")).toBe("e!\n");
  expect(r.lines).toEqual(["kept edited.ts (removed in the new version, but you edited it)", "removed gone.ts"]);
});

test("a file the app deleted stays deleted, and is listed only when upstream changed it", async () => {
  const dir = makeApp({ "a.ts": "1\n", "b.ts": "1\n" }, { "a.ts": null, "b.ts": null });
  const r = await run(dir, { "a.ts": "2\n", "b.ts": "1\n" });
  expect(existsSync(join(dir, "a.ts")) || existsSync(join(dir, "b.ts"))).toBe(false);
  expect(r).toEqual({ code: 0, lines: ["skipped a.ts (you deleted it; the new version changed it)"] });
});

test("binary files changed on both sides keep the app's copy and are listed; an untouched one is replaced", async () => {
  const bin = (...b: number[]) => Buffer.from([0xff, 0xfe, ...b]);
  const dir = makeApp({ "a.bin": bin(1), "b.bin": bin(1) }, { "a.bin": bin(9) });
  const r = await run(dir, { "a.bin": bin(2), "b.bin": bin(2) });
  expect(readFileSync(join(dir, "a.bin")).equals(bin(9))).toBe(true);
  expect(readFileSync(join(dir, "b.bin")).equals(bin(2))).toBe(true);
  expect(r).toEqual({ code: 1, lines: ["kept a.bin (binary, changed on both sides)", "replaced b.bin"] });
});

test("a merge tool error is an error, not a conflict, and the app stays untouched", async () => {
  // NUL bytes make git merge-file refuse ("Cannot merge binary files") while the text is still valid UTF-8.
  const dir = makeApp({ "ok.ts": "1\n", "nul.ts": "a\0\n" }, { "nul.ts": "b\0\n" });
  await expect(run(dir, { "ok.ts": "2\n", "nul.ts": "c\0\n" })).rejects.toThrow(/git merge-file failed on nul\.ts/);
  expect(read(dir, "ok.ts")).toBe("1\n");
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("paths with brackets work, .env and migrations are never touched, nothing is committed", async () => {
  const dir = makeApp({ "routes/api/[id].ts": "1\n", "db/migrations/0001_a.sql": "old;\n" }, { ".env": "SECRET=1\n", "db/migrations/0002_mine.sql": "mine;\n" });
  const before = git(dir, "log", "--oneline");
  const r = await run(dir, { "routes/api/[id].ts": "2\n", ".env": "SECRET=2\n", "db/migrations/0001_a.sql": "new;\n" });
  expect(r.lines.filter((l) => !l.startsWith("The schema"))).toEqual(["replaced routes/api/[id].ts"]);
  expect(read(dir, ".env")).toBe("SECRET=1\n");
  expect(read(dir, "db/migrations/0001_a.sql")).toBe("old;\n");
  expect(read(dir, "db/migrations/0002_mine.sql")).toBe("mine;\n");
  expect(git(dir, "log", "--oneline")).toBe(before);
});

test("a changed migration hash prints the void db generate reminder; an unchanged one does not", async () => {
  const dir = makeApp({ "db/migrations/0001_a.sql": "one;\n", "a.ts": "1\n" });
  const r = await run(dir, { "db/migrations/0001_a.sql": "two;\n", "a.ts": "1\n" });
  expect(r.lines.at(-1)).toContain("void db generate");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "up");
  expect((await run(dir, { "db/migrations/0001_a.sql": "two;\n", "a.ts": "1\n" })).lines).toEqual(["Nothing to do: your app is already current."]);
});

test("a file where the new version needs a folder (or the reverse) keeps the app's copy and is listed", async () => {
  const dir = makeApp({ "x.ts": "1\n" }, { "x.ts": null, "x.ts/inner": "folder\n", "y": "file\n" });
  const r = await run(dir, { "x.ts": "2\n", "y/z.ts": "z\n" });
  expect(read(dir, "x.ts/inner")).toBe("folder\n");
  expect(r.code).toBe(1); // a change the app could not take is an unresolved conflict
  expect(r.lines.sort()).toEqual(["kept x.ts (not a file in your app)", "kept y/z.ts (its path is taken by a folder or file)"]);
  expect(read(dir, "y")).toBe("file\n");
});

test("refuses, changing nothing, with no manifest, a dirty tree (untracked counts) or no git work tree", async () => {
  const none = join(mkTmp("zs-up-"), "app");
  mkdirSync(none);
  put(none, { "a.ts": "1\n" });
  git(none, "init", "-q");
  await expect(upgrade(none, () => {}, scaffoldOf({}))).rejects.toThrow(/no \.zero-stack\/manifest\.json.*docs\/upgrading\.md/);

  const dirty = makeApp({ "a.ts": "1\n" }, { "stray.txt": "x\n" }, { commit: false });
  await expect(upgrade(dirty, () => {}, scaffoldOf({ "a.ts": "2\n" }))).rejects.toThrow(/uncommitted or untracked/);
  git(dirty, "add", "-A");
  git(dirty, "commit", "-q", "-m", "app");
  put(dirty, { "stray2.txt": "x\n" });
  await expect(upgrade(dirty, () => {}, scaffoldOf({ "a.ts": "2\n" }))).rejects.toThrow(/uncommitted or untracked/);
  expect(read(dirty, "a.ts")).toBe("1\n");
  expect(existsSync(join(dirty, ".zero-stack/upgrade-tmp"))).toBe(false);

  const plain = makeApp({ "a.ts": "1\n" });
  rmSync(join(plain, ".git"), { recursive: true });
  await expect(upgrade(plain, () => {}, scaffoldOf({ "a.ts": "2\n" }))).rejects.toThrow(/not a git work tree/);
  expect(read(plain, "a.ts")).toBe("1\n");

  const bare = makeApp({ "a.ts": "1\n" });
  rmSync(join(bare, "node_modules"), { recursive: true });
  await expect(upgrade(bare, () => {}, scaffoldOf({ "a.ts": "2\n" }))).rejects.toThrow(/no node_modules: run `bun install` first/);
  expect(read(bare, "a.ts")).toBe("1\n");
  expect(existsSync(join(bare, ".zero-stack/upgrade-tmp"))).toBe(false);
});

test("a failed scaffold of the new version leaves the app untouched and no temporary folder; a leftover one is removed first", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  mkdirSync(join(dir, ".zero-stack/upgrade-tmp/app"), { recursive: true });
  writeFileSync(join(dir, ".zero-stack/upgrade-tmp/app/junk.ts"), "left by a killed run\n");
  let sawEmpty = false;
  const boom = async (_c: typeof config, target: string) => {
    sawEmpty = !existsSync(join(target, "junk.ts"));
    put(target, { "a.ts": "2\n" });
    throw new Error("network down");
  };
  await expect(upgrade(dir, () => {}, boom)).rejects.toThrow("network down");
  expect(sawEmpty).toBe(true);
  expect(existsSync(join(dir, ".zero-stack/upgrade-tmp"))).toBe(false);
  expect(read(dir, "a.ts")).toBe("1\n");
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("the folder is cleaned after a successful upgrade, and a path that leaves the app's folder is refused", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  await run(dir, { "a.ts": "2\n" });
  expect(existsSync(join(dir, ".zero-stack/upgrade-tmp"))).toBe(false);
  const base = JSON.parse(read(dir, ".zero-stack/base.json"));
  base["../escape.ts"] = base["a.ts"];
  writeFileSync(join(dir, ".zero-stack/base.json"), JSON.stringify(base, null, 2) + "\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "tampered");
  await expect(run(dir, { "a.ts": "3\n" })).rejects.toThrow(/not a file of the app/);
  expect(existsSync(join(dir, "../escape.ts"))).toBe(false);
});

test("the CLI runs upgrade in the current folder, takes no options, and exits 1 with the fix when there is no manifest", () => {
  const dir = mkTmp("zs-cli-");
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../../src/index.ts"), ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const plain = cli("upgrade");
  expect(plain.exitCode).toBe(1);
  expect(plain.stderr.toString()).toMatch(/^error: no \.zero-stack\/manifest\.json here/);
  const flagged = cli("upgrade", "--auth");
  expect(flagged.exitCode).toBe(1);
  expect(flagged.stderr.toString()).toContain("upgrade takes no arguments");
});

const commitAll = (dir: string, msg = "more") => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};
const outsideDir = (files: Record<string, string>) => {
  const out = mkTmp("zs-out-");
  for (const [p, t] of Object.entries(files)) writeFileSync(join(out, p), t);
  return out;
};

test("a symlinked folder leads nowhere: nothing outside the app is written, chmodded or removed, and the run exits 1", async () => {
  const dir = makeApp({ "scripts/run.sh": "v1\n", "scripts/gone.sh": "g\n", "a.ts": "1\n" });
  const out = outsideDir({ "run.sh": "v1\n", "gone.sh": "g\n" });
  chmodSync(join(out, "run.sh"), 0o600);
  rmSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(out, join(dir, "scripts"));
  commitAll(dir);
  const r = await run(dir, { "scripts/run.sh": "v2\n", "scripts/new.sh": "n\n", "a.ts": "1\n" });
  expect(r.code).toBe(1);
  expect(r.lines).toEqual(["kept scripts/gone.sh (outside your app)", "kept scripts/new.sh (outside your app)", "kept scripts/run.sh (outside your app)"]);
  expect(readdirSync(out).sort()).toEqual(["gone.sh", "run.sh"]);
  expect(read(out, "run.sh")).toBe("v1\n");
  expect(statSync(join(out, "run.sh")).mode & 0o777).toBe(0o600);
});

test("a symlinked .zero-stack folder is refused and nothing changes", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  const out = join(mkTmp("zs-out-"), "rec");
  renameSync(join(dir, ".zero-stack"), out);
  symlinkSync(out, join(dir, ".zero-stack"));
  commitAll(dir);
  const before = readdirSync(out).sort();
  await expect(run(dir, { "a.ts": "2\n" })).rejects.toThrow(/\.zero-stack is a symbolic link/);
  expect(readdirSync(out).sort()).toEqual(before);
  expect(read(dir, "a.ts")).toBe("1\n");
});

test("a recorded path the skip list holds back (.env, a repository file) is refused as a bad path, with nothing changed", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  const base = JSON.parse(read(dir, ".zero-stack/base.json"));
  base[".env"] = { mode: 0o644, encoding: "utf8", content: "SECRET=1\n" };
  writeFileSync(join(dir, ".zero-stack/base.json"), JSON.stringify(base, null, 2) + "\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n"); // ignored by the app's own ignore file
  commitAll(dir);
  await expect(run(dir, { "a.ts": "2\n" })).rejects.toThrow(/refusing the path ".env"/);
  expect(read(dir, ".env")).toBe("SECRET=1\n");
  expect(read(dir, "a.ts")).toBe("1\n");
});

test("only a replaced or added file takes the new mode; a merged file keeps the app's", async () => {
  const dir = makeApp({ "m.sh": lines(5), "r.sh": "1\n" }, { "m.sh": lines(5).replace("line 1", "mine") });
  chmodSync(join(dir, "m.sh"), 0o644);
  const exec = async (c: typeof config, t: string) => {
    put(t, { ".gitignore": IGNORE, "m.sh": lines(5).replace("line 5", "new"), "r.sh": "2\n", "add.sh": "a\n" });
    for (const f of ["m.sh", "r.sh", "add.sh"]) chmodSync(join(t, f), 0o755);
    writeRecord(t, c);
  };
  await upgrade(dir, () => {}, exec);
  const mode = (p: string) => statSync(join(dir, p)).mode & 0o777;
  expect([mode("m.sh"), mode("r.sh"), mode("add.sh")]).toEqual([0o644, 0o755, 0o755]);
});

test("core.autocrlf true is refused with the reason, and nothing changes", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  git(dir, "config", "core.autocrlf", "true");
  await expect(run(dir, { "a.ts": "2\n" })).rejects.toThrow(/core\.autocrlf is true/);
  expect(read(dir, "a.ts")).toBe("1\n");
});

test("a write error partway says the upgrade stopped and how to undo it", async () => {
  const dir = makeApp({ "a.ts": "1\n", "locked/b.ts": "1\n" });
  chmodSync(join(dir, "locked/b.ts"), 0o444); // a read-only file: the write fails with EACCES
  try {
    await expect(run(dir, { "a.ts": "2\n", "locked/b.ts": "2\n" })).rejects.toThrow(/stopped partway.*git checkout \. && git clean -fd/);
  } finally {
    chmodSync(join(dir, "locked/b.ts"), 0o644);
  }
});

test("a hand-edited manifest with a non-boolean flag is refused", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  const m = JSON.parse(read(dir, ".zero-stack/manifest.json"));
  m.config.auth = "yes";
  writeFileSync(join(dir, ".zero-stack/manifest.json"), JSON.stringify(m, null, 2) + "\n");
  commitAll(dir);
  await expect(run(dir, { "a.ts": "2\n" })).rejects.toThrow(/auth must be true or false/);
  expect(read(dir, "a.ts")).toBe("1\n");
});

test("a symlink at the path itself, dangling or not, is never written through: kept, exit 1, its target is not created", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  const target = join(mkTmp("zs-out-"), "zshenv");
  symlinkSync(target, join(dir, "new.ts")); // dangling, at a path the new version adds
  commitAll(dir);
  const r = await run(dir, { "a.ts": "1\n", "new.ts": "n\n" });
  expect(r).toEqual({ code: 1, lines: ["kept new.ts (not a file in your app)"] });
  expect(existsSync(target)).toBe(false);
});

const tamperBase = (dir: string, key: string) => {
  const base = JSON.parse(read(dir, ".zero-stack/base.json"));
  base[key] = { mode: 0o644, encoding: "utf8", content: "x\n" };
  writeFileSync(join(dir, ".zero-stack/base.json"), JSON.stringify(base, null, 2) + "\n");
  commitAll(dir);
};

test("recorded paths that a case-insensitive or odd file system would read as protected or elsewhere are refused, before anything is done", async () => {
  for (const key of [".GIT/HEAD", ".ENV", "Node_Modules/x.js", "a\\b.ts", "x.ts.", "x /y.ts", "a\0b.ts", "a//b.ts", "bun.loc\u212a", ".DS_\u017ftore", "A.TS"]) {
    const dir = makeApp({ "a.ts": "1\n" });
    tamperBase(dir, key);
    let scaffolded = false;
    await expect(upgrade(dir, () => {}, async () => { scaffolded = true; })).rejects.toThrow(/refusing the path/);
    expect([key, scaffolded, existsSync(join(dir, ".zero-stack/upgrade-tmp")), read(dir, "a.ts")]).toEqual([key, false, false, "1\n"]);
  }
});

test("a symlinked manifest.json or base.json is refused, so the record can't overwrite another app's", async () => {
  for (const f of ["manifest.json", "base.json"]) {
    const dir = makeApp({ "a.ts": "1\n" });
    const other = join(mkTmp("zs-out-"), f);
    renameSync(join(dir, ".zero-stack", f), other);
    symlinkSync(other, join(dir, ".zero-stack", f));
    commitAll(dir);
    const before = readFileSync(other, "utf8");
    await expect(run(dir, { "a.ts": "2\n" })).rejects.toThrow(new RegExp(`${f.replace(".", "\\.")} is a symbolic link`));
    expect(readFileSync(other, "utf8")).toBe(before);
    expect(read(dir, "a.ts")).toBe("1\n");
  }
});

test("a folder linked to another folder of the app is treated as outside: nothing is written or removed through the link", async () => {
  const dir = makeApp({ "src/x.ts": "1\n", "lib/x.ts": "1\n" });
  rmSync(join(dir, "lib"), { recursive: true });
  symlinkSync("src", join(dir, "lib"));
  commitAll(dir);
  const r = await run(dir, { "src/x.ts": "2\n", "lib/x.ts": "2\n" });
  expect(r).toEqual({ code: 1, lines: ["kept lib/x.ts (outside your app)", "replaced src/x.ts"] });
  expect(read(dir, "src/x.ts")).toBe("2\n");
  const dir2 = makeApp({ "src/x.ts": "1\n", "lib/x.ts": "1\n" });
  rmSync(join(dir2, "lib"), { recursive: true });
  symlinkSync("src", join(dir2, "lib"));
  commitAll(dir2);
  const r2 = await run(dir2, { "lib/x.ts": "1\n" }); // src/x.ts removed upstream; the link must not carry a delete of lib/x.ts too
  expect(r2.lines).toEqual(["kept lib/x.ts (outside your app)", "removed src/x.ts"]);
});

const UNDO = "To undo this upgrade, run:\n  git checkout .\n  git clean -fd";

test("the summary counts each outcome, and the undo commands come last", async () => {
  const dir = makeApp(
    { "a.ts": "1\n", "b.ts": "1\n", "c.ts": "1\n", "d.ts": lines(3), "e.ts": lines(3) },
    { "d.ts": lines(3).replace("line 1", "mine"), "e.ts": lines(3).replace("line 2", "mine") },
  );
  const r = await runAll(dir, { "a.ts": "2\n", "c.ts": "1\n", "d.ts": lines(3).replace("line 3", "new"), "e.ts": lines(3).replace("line 2", "theirs"), "f.ts": "new\n" });
  expect(r.code).toBe(1);
  expect(r.lines).toEqual([
    "replaced a.ts", "removed b.ts", "merged d.ts", "CONFLICT e.ts", "added f.ts",
    "Summary: 1 replaced, 1 added, 1 removed, 1 merged, 0 kept, 1 in conflict.",
    UNDO,
  ]);
});

test("nothing to do exits 0 and prints no undo commands", async () => {
  const dir = makeApp({ "a.ts": "1\n" });
  expect(await runAll(dir, { "a.ts": "1\n" })).toEqual({ code: 0, lines: ["Nothing to do: your app is already current."] });
});

test("an edited scaffold-owned file is named with the app-owned file where the change belongs; an edited app-owned one is not", async () => {
  const files = { "src/settings.ts": lines(5), "src/mail.ts": lines(5), "pages/index.svelte": lines(5) };
  const mine = (t: string) => t.replace("line 1", "mine 1");
  const dir = makeApp(files, { "src/settings.ts": mine(lines(5)), "src/mail.ts": mine(lines(5)), "pages/index.svelte": mine(lines(5)) });
  const r = await runAll(dir, Object.fromEntries(Object.keys(files).map((p) => [p, lines(5).replace("line 5", "new 5")])));
  expect(r.lines.filter((l) => l.startsWith("You edited "))).toEqual([
    "You edited src/mail.ts, which zero-stack owns. Move the change to an app-owned file (AGENTS.md lists them).",
    "You edited src/settings.ts, which zero-stack owns. Declare settings in src/app/settings.ts.",
  ]);
});

test("package.json changing says to run bun install, before the undo commands; unchanged says nothing", async () => {
  const dir = makeApp({ "package.json": '{"a":1}\n', "a.ts": "1\n" });
  const r = await runAll(dir, { "package.json": '{"a":2}\n', "a.ts": "1\n" });
  expect(r.lines).toEqual(["replaced package.json", "Summary: 1 replaced, 0 added, 0 removed, 0 merged, 0 kept, 0 in conflict.", "package.json changed: run `bun install`.", UNDO]);
  const other = makeApp({ "package.json": '{"a":1}\n', "a.ts": "1\n" });
  expect((await runAll(other, { "package.json": '{"a":1}\n', "a.ts": "2\n" })).lines.some((l) => l.includes("bun install"))).toBe(false);
});

test("package.json in conflict says to resolve it before bun install", async () => {
  const dir = makeApp({ "package.json": lines(3) }, { "package.json": lines(3).replace("line 2", "mine") });
  const r = await runAll(dir, { "package.json": lines(3).replace("line 2", "theirs") });
  expect(r.code).toBe(1);
  expect(r.lines).toContain("package.json is in conflict: resolve it, then run `bun install`.");
  expect(r.lines.some((l) => l === "package.json changed: run `bun install`.")).toBe(false);
});

test("kept files are counted, so the counts add up to the lines above them", async () => {
  const dir = makeApp({ "a.ts": "1\n", "b.ts": "1\n" }, { "a.ts": "mine\n", "b.ts": null });
  const r = await runAll(dir, { "b.ts": "2\n" });
  expect(r.lines.slice(0, 2)).toEqual(["kept a.ts (removed in the new version, but you edited it)", "skipped b.ts (you deleted it; the new version changed it)"]);
  expect(r.lines).toContain("Summary: 0 replaced, 0 added, 0 removed, 0 merged, 2 kept, 0 in conflict.");
});

test("a run that changes only the record still prints the undo commands; a byte-identical record is left alone", async () => {
  const dir = makeApp({ "db/migrations/0001_a.sql": "one;\n", "a.ts": "1\n" });
  const r = await runAll(dir, { "db/migrations/0001_a.sql": "two;\n", "a.ts": "1\n" });
  expect(r.lines[0]).toBe("No file of yours changed; .zero-stack/ now records the new version.");
  expect(r.lines.at(-1)).toBe(UNDO);
  expect(git(dir, "status", "--porcelain")).toContain(".zero-stack/manifest.json");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "up");
  expect(await runAll(dir, { "db/migrations/0001_a.sql": "two;\n", "a.ts": "1\n" })).toEqual({ code: 0, lines: ["Nothing to do: your app is already current."] });
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("paths that differ only by case get their own refusal, nothing changes", async () => {
  const dir = makeApp({ "Readme.md": "1\n" });
  await expect(upgrade(dir, () => {}, scaffoldOf({ "README.md": "1\n" }))).rejects.toThrow(/"README.md" and "Readme.md": they differ only by case/);
  expect(read(dir, "Readme.md")).toBe("1\n");
});
