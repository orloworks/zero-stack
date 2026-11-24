import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFlags } from "../../src/flags";
import { bytesOf, listFiles, migrationsHash, readTree, writeRecord } from "../../src/manifest";

const tmp = () => mkdtempSync(join(tmpdir(), "zs-man-"));
const put = (dir: string, files: Record<string, string | Buffer>) => {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
};
const config = validateFlags({ name: "app", framework: "svelte", auth: true }).config;

test("the base copy never holds .env, installed packages, build output, Void's files, the lockfile, migrations or its own folder", () => {
  const dir = tmp();
  const never = [
    ".env", ".env.local", ".env.pull-tmp", "node_modules/a/index.js", "src/node_modules/b.js", "dist/client/x.js", ".void/db.d.ts", ".wrangler/s", ".cloudflare/o",
    ".void-wrangler.jsonc", "bun.lock", "db/migrations/0001_x.sql", "db/migrations/meta/_journal.json", ".zero-stack/base.json", ".zero-stack/upgrade-tmp/app/x.ts",
    ".git/HEAD", ".DS_Store", "pages/.DS_Store", "tsconfig.tsbuildinfo",
  ];
  const keep = [".gitignore", "env.ts", "db/schema.ts", "db/migrations.ts", "src/dist.ts", ".mcp.json", "bun.lock.md", ".envrc"];
  put(dir, Object.fromEntries([...never, ...keep].map((p) => [p, "x\n"])));
  expect(listFiles(dir)).toEqual([...keep].sort());
});

test("the base copy keeps file modes and binary content", () => {
  const dir = tmp();
  const png = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00]);
  put(dir, { "scripts/run.sh": "#!/bin/sh\n", "public/a.png": png, "é/ü.txt": "ünï\n" });
  chmodSync(join(dir, "scripts/run.sh"), 0o755);
  const t = readTree(dir);
  expect(t["scripts/run.sh"]!.mode).toBe(0o755);
  expect(t["public/a.png"]!.encoding).toBe("base64");
  expect(bytesOf(t["public/a.png"]!).equals(png)).toBe(true);
  expect(t["é/ü.txt"]).toMatchObject({ encoding: "utf8", content: "ünï\n" });
});

test("two scaffolds of one version and configuration record the same thing; migration names and timestamps stay out", () => {
  const make = (stamp: string) => {
    const dir = tmp();
    put(dir, {
      "src/a.ts": "a\n", ".env": `BETTER_AUTH_SECRET=${stamp}\n`,
      [`db/migrations/${stamp}_x.sql`]: "CREATE TABLE a;\n", [`db/migrations/${stamp}2_y.sql`]: "CREATE TABLE b;\n",
      "db/migrations/meta/_journal.json": `{"when":${stamp}}`,
    });
    writeRecord(dir, config);
    return dir;
  };
  const [a, b] = [make("20261124000001"), make("20261124999999")];
  for (const f of ["manifest.json", "base.json"]) expect(readFileSync(join(a, ".zero-stack", f), "utf8")).toBe(readFileSync(join(b, ".zero-stack", f), "utf8"));
  expect(JSON.parse(readFileSync(join(a, ".zero-stack/manifest.json"), "utf8"))).toMatchObject({ formatVersion: 1, config: { name: "app", framework: "svelte", auth: true } });
  expect(migrationsHash(a)).toMatch(/^[0-9a-f]{64}$/);
  put(b, { "db/migrations/20261124999999_x.sql": "CREATE TABLE changed;\n" });
  expect(migrationsHash(b)).not.toBe(migrationsHash(a));
});

test("no migrations means no hash, and the record is formatter-clean JSON", () => {
  const dir = tmp();
  put(dir, { "src/a.ts": "a\n" });
  writeRecord(dir, config);
  expect(migrationsHash(dir)).toBeNull();
  for (const f of ["manifest.json", "base.json"]) {
    const text = readFileSync(join(dir, ".zero-stack", f), "utf8");
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + "\n");
  }
});
