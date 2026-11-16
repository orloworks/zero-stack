import { editFile, replaceAnchor } from "../anchor";

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
  const f = "tsconfig.json";
  editFile(dir, f, (s) => {
    if (s.includes('"paths": {')) {
      // an empty `"paths": {}` must not leave a trailing comma
      const empty = /"paths":\s*\{\s*\}/;
      return empty.test(s) ? s.replace(empty, () => `"paths": {\n${entries(extra)}\n}`) : replaceAnchor(s, '"paths": {', `"paths": {\n${entries(extra)},`, f);
    }
    const paths = `"paths": {\n${entries({ ...VOID_PATHS, ...extra })}\n}`;
    const empty = /"compilerOptions":\s*\{\s*\}/;
    return empty.test(s)
      ? s.replace(empty, () => `"compilerOptions": {\n${paths}\n}`)
      : replaceAnchor(s, '"compilerOptions": {', `"compilerOptions": {\n${paths},`, f);
  });
}
