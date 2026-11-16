import { editFile, editJson, needKey, replaceAnchor } from "../anchor";
import { TAILWIND } from "../versions";

// Needs a `bun install` afterwards (the pipeline runs one).
export function installTailwind(dir: string): void {
  editJson(dir, "package.json", (pkg) => {
    Object.assign(needKey(pkg, "devDependencies", "package.json"), { tailwindcss: TAILWIND, "@tailwindcss/vite": TAILWIND });
  });
  editFile(dir, "vite.config.ts", (s) => {
    const f = "vite.config.ts";
    s = replaceAnchor(s, 'import { defineConfig } from "vite";', 'import { defineConfig } from "vite";\nimport tailwindcss from "@tailwindcss/vite";', f);
    return replaceAnchor(s, "plugins: [", "plugins: [tailwindcss(), ", f); // formatting fixed by `vp check --fix`
  });
  editFile(dir, "pages/style.css", (s) => replaceAnchor(s, ":root {\n  --text:", '@import "tailwindcss";\n\n:root {\n  --text:', "pages/style.css"));
}
