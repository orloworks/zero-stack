// Runs the unit suite with TMPDIR pointed at a fresh folder and fails if anything but bun's own bunx-* cache is left.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "zs-leak-"));
try {
  const r = Bun.spawnSync([process.execPath, "test", "tests/unit"], { env: { ...process.env, TMPDIR: dir }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  const left = readdirSync(dir).filter((e) => !e.startsWith("bunx-"));
  if (left.length) { console.error(`unit tests left temp entries behind:\n  ${left.join("\n  ")}`); process.exit(1); }
} finally { rmSync(dir, { recursive: true, force: true }); }
