import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREATE_VOID } from "./versions";

// The one error shape for "the generated output changed".
export const anchorError = (anchor: string, file: string, problem = "not found") =>
  new Error(
    `Anchor ${JSON.stringify(anchor)} ${problem} in ${file} (create-void@${CREATE_VOID}). ` +
      `The generated output changed; update the installer.`,
  );

// Replace the one occurrence of `anchor` in `text`; anything else is a hard error.
export function replaceAnchor(text: string, anchor: string, replacement: string, file: string): string {
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw anchorError(anchor, file, n === 0 ? "not found" : `found ${n} times`);
  return text.replace(anchor, () => replacement);
}

export function editFile(dir: string, file: string, fn: (s: string) => string): void {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

export function editJson(dir: string, file: string, fn: (json: any) => void): void {
  editFile(dir, file, (s) => {
    const json = JSON.parse(s);
    fn(json);
    return JSON.stringify(json, null, 2) + "\n";
  });
}

// An expected object key in generated JSON; missing is an anchor error, not a TypeError.
export function needKey(obj: any, key: string, file: string): any {
  if (obj?.[key] == null) throw anchorError(key, file);
  return obj[key];
}

// Void's generated mappings (.void/tsconfig.json). A `paths` entry in tsconfig.json replaces them
// (Void auth docs), so they are written whenever we create `paths`.
const VOID_PATHS = {
  "void/db": ["./.void/db.d.ts"],
  "@schema": ["./db/schema.ts"],
  "@schema/*": ["./db/schema/*"],
  "void/routes": ["./.void/routes.d.ts"],
};

// Adds `extra` mappings to tsconfig.json by anchored edit, creating `paths` (with Void's four) if absent.
export function addPaths(dir: string, extra: Record<string, string[]>): void {
  const entries = (m: object) => Object.entries(m).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
  editFile(dir, "tsconfig.json", (s) =>
    s.includes('"paths": {')
      ? replaceAnchor(s, '"paths": {', `"paths": {\n${entries(extra)},`, "tsconfig.json")
      : replaceAnchor(s, '"compilerOptions": {', `"compilerOptions": {\n"paths": {\n${entries({ ...VOID_PATHS, ...extra })}\n},`, "tsconfig.json"),
  );
}
