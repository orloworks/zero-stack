import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, isGreen, nodeVersion, runPool } from "../../scripts/ci-full";
import { MATRIX } from "../../scripts/matrix";
import { argv, FEATURE_LIST, validateFlags } from "../../src/flags";
import { tmpMaker } from "./tmp";
const mkTmp = tmpMaker();

test("never more than 2 in flight", async () => {
  let live = 0, peak = 0;
  await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
    peak = Math.max(peak, ++live);
    await Bun.sleep(10);
    live--;
    return true;
  });
  expect(peak).toBe(2);
});

test("a failure stops new work but lets in-flight finish", async () => {
  const done: number[] = [];
  const r = await runPool([1, 2, 3, 4], 2, async (n) => {
    await Bun.sleep(n === 1 ? 5 : 30);
    done.push(n);
    return n !== 1;
  });
  expect(done.sort()).toEqual([1, 2]); // 2 was in flight and finished; 3 and 4 never started
  expect(r.includes(false)).toBe(true);
});

test("every matrix entry is a valid flag set", () => {
  for (const p of MATRIX) {
    const a = p.args, i = a.indexOf("--framework");
    const on = Object.fromEntries(FEATURE_LIST.map((f) => [f.key, a.join(" ").includes(argv(f).join(" "))]));
    expect(() => validateFlags({ name: "x", framework: i >= 0 ? a[i + 1] : undefined, ...on })).not.toThrow();
  }
});

test("every feature in the table appears in the matrix", () => {
  const used = new Set(MATRIX.flatMap((p) => p.args));
  for (const f of FEATURE_LIST) expect(used.has(`--${f.flag}`)).toBe(true);
});

test("the matrix has svelte-secrets, with the argv() form of the valued flag", () => {
  expect(MATRIX.find((p) => p.name === "svelte-secrets")?.args).toEqual(["--framework", "svelte", "--secrets", "infisical"]);
  for (const fw of ["react", "vue", "svelte", "solid"])
    expect(MATRIX.find((p) => p.name === `${fw}-all`)!.args.join(" ")).toContain("--secrets infisical");
});

test("hash is stable and tracks gate.ts and the routing doc", () => {
  const repo = join(import.meta.dir, "../..");
  const tmp = mkTmp("zs-hash-");
  for (const d of ["src", "template", "docs", "scripts"]) mkdirSync(join(tmp, d), { recursive: true });
  for (const f of ["src/a.ts", "template/b.txt", "docs/cloudflare-routing.md", "scripts/gate.ts", "package.json", "bun.lock"])
    writeFileSync(join(tmp, f), f);
  const h0 = hash(tmp, ["--auth"], "v1");
  expect(hash(tmp, ["--auth"], "v1")).toBe(h0);
  writeFileSync(join(tmp, "scripts/gate.ts"), "changed");
  const h1 = hash(tmp, ["--auth"], "v1");
  expect(h1).not.toBe(h0);
  writeFileSync(join(tmp, "docs/cloudflare-routing.md"), "changed");
  expect(hash(tmp, ["--auth"], "v1")).not.toBe(h1);
  expect(hash(repo, [], "v1")).toMatch(/^[0-9a-f]{64}$/); // real repo has every input file
});

test("the Node version is part of the hash", () => {
  const repo = join(import.meta.dir, "../..");
  expect(hash(repo, [], "v24.22.0")).not.toBe(hash(repo, [], "v26.13.1"));
});

test("nodeVersion reads `node` from PATH", () => {
  const bin = mkTmp("zs-node-");
  writeFileSync(join(bin, "node"), "#!/bin/sh\necho v24.22.0\n");
  chmodSync(join(bin, "node"), 0o755);
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    expect(nodeVersion().trim()).toBe("v24.22.0");
  } finally {
    process.env.PATH = path;
  }
});

test("--force ignores a warm green cache", () => {
  expect(isGreen({ a: "h" }, "a", "h", false)).toBe(true);
  expect(isGreen({ a: "h" }, "a", "h", true)).toBe(false);
});

test("the matrix runs --admin alone and with --storage, and svelte-all picks it up from the table", () => {
  expect(MATRIX.find((p) => p.name === "svelte-admin")?.args).toEqual(["--framework", "svelte", "--admin"]);
  expect(MATRIX.find((p) => p.name === "svelte-admin-storage")?.args).toEqual(["--framework", "svelte", "--admin", "--storage"]);
  expect(MATRIX.find((p) => p.name === "svelte-admin-invite-only")?.args).toEqual(["--framework", "svelte", "--admin", "--invite-only"]);
  expect(MATRIX.find((p) => p.name === "svelte-all")!.args).toContain("--admin");
  for (const fw of ["react", "vue", "solid"]) expect(MATRIX.find((p) => p.name === `${fw}-all`)!.args).not.toContain("--admin");
});
