// Points this clone at the committed hooks. Run once per clone.
const r = Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"], { stdout: "inherit", stderr: "inherit" });
process.exit(r.exitCode);
