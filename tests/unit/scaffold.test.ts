import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../../src/pipeline";

const tmp = () => mkdtempSync(join(tmpdir(), "zs-test-"));
const cfg = { name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false } as const;

test("refuses a non-empty target and writes nothing", async () => {
  const dir = join(tmp(), "app");
  mkdirSync(dir);
  writeFileSync(join(dir, "keep.txt"), "x");
  await expect(scaffold(cfg, dir, async () => { throw new Error("must not run"); })).rejects.toThrow(/not empty/);
  expect(readdirSync(dir)).toEqual(["keep.txt"]);
});

test("a failure after the directory is created leaves no directory behind", async () => {
  const dir = join(tmp(), "app");
  await expect(
    scaffold(cfg, dir, async () => { mkdirSync(dir); throw new Error("boom"); }),
  ).rejects.toThrow(/boom/);
  expect(existsSync(dir)).toBe(false);
});

test("wrong Node version exits 1 with the supported range", () => {
  const bin = tmp();
  writeFileSync(join(bin, "node"), "#!/bin/sh\necho v20.1.0\n");
  chmodSync(join(bin, "node"), 0o755);
  const r = Bun.spawnSync([process.execPath, "src/index.ts", join(tmp(), "app")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("^24.22 || >=26.12");
});

test("--shadcn with a non-React framework exits 1 with the fix and creates nothing", () => {
  const dir = join(tmp(), "app");
  const r = Bun.spawnSync([process.execPath, "src/index.ts", dir, "--framework", "vue", "--shadcn"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain(
    "error: --shadcn requires --framework react (got vue); drop --shadcn or use --framework react.",
  );
  expect(existsSync(dir)).toBe(false);
});
