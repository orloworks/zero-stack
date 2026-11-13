import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "../../.githooks/pre-push");

// A stub `bun` first on PATH stands in for `bun run ci`, so no real code is broken.
const run = (exit: number) => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  writeFileSync(join(dir, "bun"), `#!/bin/sh\n[ "$*" = "run ci" ] || exit 99\nexit ${exit}\n`);
  chmodSync(join(dir, "bun"), 0o755);
  return Bun.spawnSync(["sh", hook], { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } }).exitCode;
};

test("pre-push hook blocks when bun run ci fails", () => expect(run(1)).toBe(1));
test("pre-push hook passes when bun run ci is green", () => expect(run(0)).toBe(0));
