import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./manifest";

// The one ownership rule for a generated svelte app (GLOSSARY: scaffold-owned file). Everything else is app-owned.
// The admin layout holds the navigation an app extends, and src/app/ holds the declaration files, so both stay the app's.
export const scaffoldOwned = (p: string): boolean =>
  /^(auth\.ts|docs\/setup\.md|middleware\/10\.admin\.ts|routes\/api\/files\/\[name\]\.ts)$/.test(p) ||
  (/^(src|scripts|tests|db\/schema|pages\/admin|routes\/admin|routes\/api\/admin)\//.test(p) && !p.startsWith("src/app/") && p !== "pages/admin/layout.svelte");

// The app-owned file to edit instead, where there is one.
const EDIT_INSTEAD: Record<string, string> = {
  "src/onboarding.ts": "Declare onboarding steps in src/app/onboarding.ts.",
  "src/settings.ts": "Declare settings in src/app/settings.ts.",
};
export const editInstead = (p: string): string => EDIT_INSTEAD[p] ?? "Move the change to an app-owned file (AGENTS.md lists them).";

const noticeText = (p: string) =>
  `Scaffold-owned by zero-stack: an upgrade merges new versions into this file. Keep your changes in app-owned files (AGENTS.md lists them).${EDIT_INSTEAD[p] ? ` ${EDIT_INSTEAD[p]}` : ""}`;

const COMMENT: Record<string, (t: string) => string> = {
  ts: (t) => `// ${t}`,
  svelte: (t) => `<!-- ${t} -->`,
  md: (t) => `<!-- ${t} -->`,
  css: (t) => `/* ${t} */`,
  sh: (t) => `# ${t}`,
};

// The file with its notice, or null when its format has no comments (JSON and the rest). Line 2 under a shebang.
export function withNotice(p: string, text: string): string | null {
  const comment = COMMENT[p.split(".").at(-1)!];
  if (!comment) return null;
  const line = comment(noticeText(p)) + "\n";
  if (!text.startsWith("#!")) return line + text;
  const nl = text.indexOf("\n") + 1;
  return nl ? text.slice(0, nl) + line + text.slice(nl) : text + "\n" + line;
}

// After the last generated file is written and before formatting.
export function addNotices(dir: string): void {
  for (const p of listFiles(dir).filter(scaffoldOwned)) {
    const out = withNotice(p, readFileSync(join(dir, p), "utf8"));
    if (out !== null) writeFileSync(join(dir, p), out);
  }
}
