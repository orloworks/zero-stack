import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpMaker } from "./tmp";
const mkTmp = tmpMaker();

const hook = join(import.meta.dir, "../../.githooks/pre-push");

// A stub `bun` first on PATH stands in for `bun run ci`, so no real code is broken.
const run = (exit: number, env: Record<string, string> = {}) => {
  const dir = mkTmp("hook-");
  writeFileSync(join(dir, "bun"), `#!/bin/sh\n[ "$*" = "run ci" ] || exit 99\n[ -z "$GIT_DIR$GIT_WORK_TREE$GIT_INDEX_FILE" ] || exit 98\nexit ${exit}\n`);
  chmodSync(join(dir, "bun"), 0o755);
  return Bun.spawnSync(["sh", hook], { env: { ...process.env, ...env, PATH: `${dir}:/usr/bin:/bin` } }).exitCode;
};

test("pre-push hook blocks when bun run ci fails", () => expect(run(1)).toBe(1));
test("pre-push hook passes when bun run ci is green", () => expect(run(0)).toBe(0));
// Git exports GIT_DIR to hooks; a scaffold's child git inheriting it re-inits this repo as bare (core.bare=true).
test("pre-push hook clears git's repo env before running ci", () =>
  expect(run(0, { GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/.git/index" })).toBe(0));
