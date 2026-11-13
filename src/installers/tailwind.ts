import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceAnchor } from "../anchor";
import { TAILWIND } from "../versions";

const edit = (dir: string, file: string, fn: (s: string) => string) => {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
};

// Needs a `bun install` afterwards (the pipeline runs one).
export function installTailwind(dir: string): void {
  edit(dir, "package.json", (s) => {
    const pkg = JSON.parse(s);
    Object.assign(pkg.devDependencies, { tailwindcss: TAILWIND, "@tailwindcss/vite": TAILWIND });
    return JSON.stringify(pkg, null, 2) + "\n";
  });
  edit(dir, "vite.config.ts", (s) => {
    const f = "vite.config.ts";
    s = replaceAnchor(s, 'import { defineConfig } from "vite";', 'import { defineConfig } from "vite";\nimport tailwindcss from "@tailwindcss/vite";', f);
    return replaceAnchor(s, "plugins: [", "plugins: [tailwindcss(), ", f); // formatting fixed by `vp check --fix`
  });
  edit(dir, "pages/style.css", (s) => replaceAnchor(s, ":root {\n  --text:", '@import "tailwindcss";\n\n:root {\n  --text:', "pages/style.css"));
}
