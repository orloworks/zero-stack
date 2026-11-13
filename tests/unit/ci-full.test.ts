import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, runPool } from "../../scripts/ci-full";
import { MATRIX } from "../../scripts/matrix";
import { validateFlags } from "../../src/flags";

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
    expect(() => validateFlags({ name: "x", framework: i >= 0 ? a[i + 1] : undefined, shadcn: a.includes("--shadcn") })).not.toThrow();
  }
});

test("hash is stable and tracks gate.ts and the routing doc", () => {
  const repo = join(import.meta.dir, "../..");
  const tmp = mkdtempSync(join(tmpdir(), "zs-hash-"));
  for (const d of ["src", "template", "docs", "scripts"]) mkdirSync(join(tmp, d), { recursive: true });
  for (const f of ["src/a.ts", "template/b.txt", "docs/cloudflare-routing.md", "scripts/gate.ts", "package.json", "bun.lock"])
    writeFileSync(join(tmp, f), f);
  const h0 = hash(tmp, ["--auth"]);
  expect(hash(tmp, ["--auth"])).toBe(h0);
  writeFileSync(join(tmp, "scripts/gate.ts"), "changed");
  const h1 = hash(tmp, ["--auth"]);
  expect(h1).not.toBe(h0);
  writeFileSync(join(tmp, "docs/cloudflare-routing.md"), "changed");
  expect(hash(tmp, ["--auth"])).not.toBe(h1);
  expect(hash(repo, [])).toMatch(/^[0-9a-f]{64}$/); // real repo has every input file
});
