import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import type { Config } from "./flags";

export const FORMAT_VERSION = 1;
export const RECORD_DIR = ".zero-stack";
export const UPGRADE_TMP = `${RECORD_DIR}/upgrade-tmp`;

export type Entry = { mode: number; encoding: "utf8" | "base64"; content: string };
export type BaseCopy = Record<string, Entry>;
export type Manifest = { formatVersion: number; zeroStack: string; config: Config; migrations: string | null };

// The one fixed skip list of the base copy (not git: a nested scaffold has no repository of its own). Never in it: .env and every other
// ignored file, installed packages, build output, Void's generated folder and config, the lockfile, migrations, and this folder.
const SKIP = new RegExp(
  [
    "(^|/)(node_modules|\\.git|\\.void|\\.wrangler|\\.cloudflare|dist|\\.DS_Store)(/|$)",
    "^(\\.zero-stack|db/migrations)(/|$)",
    "^\\.env(\\..*)?$",
    "^(bun\\.lock|\\.void-wrangler\\.jsonc)$",
    "\\.tsbuildinfo$",
  ].join("|"),
  "i", // macOS and Windows file systems ignore case: `.GIT/HEAD` is the repository
);
export const skipped = (rel: string): boolean => SKIP.test(rel);

// A recorded path the upgrade must never act on: outside the app, held back by the skip list, or spelled so that a file system may read it as something else.
// Printable ASCII only: APFS folds case across Unicode (a Kelvin sign opens as "k"), so a look-alike spelling could name a held-back file.
export const badPath = (p: string): boolean =>
  p.startsWith("/") || /[^\x20-\x7e]/.test(p) || p.includes("\\") || p.split("/").some((part) => part === "" || part === ".." || /[. ]$/.test(part)) || skipped(p);

// Every file of a generated app that the base copy covers, as sorted relative paths.
export function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => {
      const p = rel ? `${rel}/${e.name}` : e.name;
      return skipped(p) ? [] : e.isDirectory() ? listFiles(dir, p) : e.isFile() ? [p] : [];
    });
}

export function entryOf(buf: Buffer, mode: number): Entry {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? { mode, encoding: "utf8", content: text } : { mode, encoding: "base64", content: buf.toString("base64") };
}
export const bytesOf = (e: Entry): Buffer => Buffer.from(e.content, e.encoding);

export const readTree = (dir: string): BaseCopy =>
  Object.fromEntries(listFiles(dir).map((p) => [p, entryOf(readFileSync(join(dir, p)), statSync(join(dir, p)).mode & 0o111 ? 0o755 : 0o644)]));

// SQL only: migration file names and the journal carry a timestamp, so they stay out. Stable between two scaffolds (docs/facts.md).
export function migrationsHash(dir: string): string | null {
  const m = join(dir, "db/migrations");
  const sql = existsSync(m) ? readdirSync(m).filter((f) => f.endsWith(".sql")).sort() : [];
  if (!sql.length) return null;
  const h = createHash("sha256");
  for (const f of sql) h.update(readFileSync(join(m, f)));
  return h.digest("hex");
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n"; // formatter-clean: `vp check` scans this folder (docs/facts.md)

// The very last write of a svelte scaffold, after formatting, so the base copy matches the files on disk.
export function writeRecord(dir: string, config: Config): void {
  const manifest: Manifest = { formatVersion: FORMAT_VERSION, zeroStack: version, config, migrations: migrationsHash(dir) };
  const base = readTree(dir);
  mkdirSync(join(dir, RECORD_DIR), { recursive: true });
  writeFileSync(join(dir, RECORD_DIR, "manifest.json"), json(manifest));
  writeFileSync(join(dir, RECORD_DIR, "base.json"), json(base));
}
