import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../../src/pipeline";

const tmp = () => mkdtempSync(join(tmpdir(), "zs-test-"));
const cfg = { name: "app", framework: "react" } as const;

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

function seeded(agents: string, scripts: object = { postinstall: "void prepare" }) {
  const dir = join(tmp(), "app");
  return {
    dir,
    exec: async (cmd: string[]) => {
      if (cmd[1] !== "x") return;
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
      writeFileSync(join(dir, "AGENTS.md"), agents);
    },
  };
}

test("adds verify, test, db:reset, the route test and a fenced AGENTS.md line", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  await scaffold(cfg, dir, exec);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  expect(pkg.scripts.verify).toBe("void prepare && vp check && vp build && vp test");
  expect(pkg.scripts["db:reset"]).toBe("void db reset --yes");
  expect(pkg.scripts.test).toBe("vp test");
  expect(existsSync(join(dir, "tests/hello.test.ts"))).toBe(true);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toMatch(/<!-- zero-stack:verify -->[^]*verify[^]*<!-- \/zero-stack:verify -->/);
});

test("a missing AGENTS.md anchor is a hard error and leaves no directory", async () => {
  const { dir, exec } = seeded("no anchor here");
  await expect(scaffold(cfg, dir, exec)).rejects.toThrow(/anchor missing/);
  expect(existsSync(dir)).toBe(false);
});
