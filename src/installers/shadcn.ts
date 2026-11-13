import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replaceAnchor } from "../anchor";
import { CLASS_VARIANCE_AUTHORITY, CLSX, TAILWIND_MERGE } from "../versions";

const edit = (dir: string, file: string, fn: (s: string) => string) => {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
};

// Runs after installTailwind (shadcn implies it). Needs a `bun install` afterwards.
// shortcut: hand-written files instead of `shadcn init`, which is interactive/network-bound; re-check on shadcn upgrades.
export function installShadcn(dir: string): void {
  const slice = join(dirname(fileURLToPath(import.meta.url)), "../../template/shadcn");
  edit(dir, "package.json", (s) => {
    const pkg = JSON.parse(s);
    Object.assign(pkg.dependencies, {
      "class-variance-authority": CLASS_VARIANCE_AUTHORITY,
      clsx: CLSX,
      "tailwind-merge": TAILWIND_MERGE,
    });
    return JSON.stringify(pkg, null, 2) + "\n";
  });
  // `paths` in a child tsconfig replaces the generated ones, so retain them (Void auth docs).
  edit(dir, "tsconfig.json", (s) =>
    replaceAnchor(
      s,
      '"jsx": "react-jsx"',
      `"jsx": "react-jsx",
    "paths": {
      "@/*": ["./src/*"],
      "void/db": ["./.void/db.d.ts"],
      "@schema": ["./db/schema.ts"],
      "@schema/*": ["./db/schema/*"],
      "void/routes": ["./.void/routes.d.ts"]
    }`,
      "tsconfig.json",
    ),
  );
  edit(dir, "vite.config.ts", (s) => {
    const f = "vite.config.ts";
    s = replaceAnchor(s, "export default defineConfig({", 'export default defineConfig({\n  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },', f);
    return s;
  });
  appendFileSync(join(dir, "pages/style.css"), readFileSync(join(slice, "shadcn.css")));
  cpSync(join(slice, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(slice, "components.json"), join(dir, "components.json"));
  edit(dir, "pages/index.tsx", (s) => {
    const f = "pages/index.tsx";
    s = replaceAnchor(s, 'import "./style.css";', 'import { Button } from "@/components/ui/button";\nimport "./style.css";', f);
    return replaceAnchor(s, "Welcome to Void</h1>", "Welcome to Void</h1>\n          <Button>shadcn/ui</Button>", f);
  });
}
