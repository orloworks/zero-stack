import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

/** Call once at the top of a test file: returns a mkdtemp that removes every folder it made when that file finishes. */
export const tmpMaker = () => {
  const made: string[] = [];
  afterAll(() => { for (const p of made) rmSync(p, { recursive: true, force: true }); });
  return (prefix: string) => { const p = mkdtempSync(join(tmpdir(), prefix)); made.push(p); return p; };
};
