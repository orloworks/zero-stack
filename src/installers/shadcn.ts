import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addPaths, editFile as edit, editJson, needKey, replaceAnchor } from "../anchor";
import { CLASS_VARIANCE_AUTHORITY, CLSX, TAILWIND_MERGE } from "../versions";

// Runs after installTailwind (shadcn implies it). Needs a `bun install` afterwards.
// shortcut: hand-written files instead of `shadcn init`, which is interactive/network-bound; re-check on shadcn upgrades.
export function installShadcn(dir: string): void {
  const slice = join(dirname(fileURLToPath(import.meta.url)), "../../template/shadcn");
  editJson(dir, "package.json", (pkg) => {
    Object.assign(needKey(pkg, "dependencies", "package.json"), {
      "class-variance-authority": CLASS_VARIANCE_AUTHORITY,
      clsx: CLSX,
      "tailwind-merge": TAILWIND_MERGE,
    });
  });
  addPaths(dir, { "@/*": ["./src/*"] });
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
