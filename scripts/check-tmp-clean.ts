// Runs the unit suite with TMPDIR pointed at a fresh folder and fails if anything but bun's own bunx-* cache is left.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "zs-leak-"));
// The code is set, not exited with, inside the try: process.exit there would skip the finally and leave this folder behind.
let code = 0;
try {
  const r = Bun.spawnSync([process.execPath, "test", "tests/unit"], { env: { ...process.env, TMPDIR: dir }, stdout: "inherit", stderr: "inherit" });
  const left = readdirSync(dir).filter((e) => !e.startsWith("bunx-"));
  if (r.exitCode !== 0) code = r.exitCode ?? 1;
  else if (left.length) { console.error(`unit tests left temp entries behind:\n  ${left.join("\n  ")}`); code = 1; }
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(code);
