import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editFile, replaceAnchor } from "../anchor";

const here = join(dirname(fileURLToPath(import.meta.url)), "../../template/marketing/svelte");
const SCHEMA = "db/schema.ts";
const DECLARATIONS = "tests/declarations.test.ts";

// The lists file's checks, added to the admin declarations test: unique lower-case names, and a label and description to show. They run on the app's file and on bad examples.
const LIST_CHECKS = `// Names are what the database and the unsubscribe link keep, always lowercase; the label and description are what a subscriber is shown and agrees to.
function listProblems(lists: readonly { name: string; label: string; description: string }[]): string[] {
  const out = duplicates(lists.map((l) => l.name)).map((n) => \`the list "\${n}" is declared twice\`);
  for (const l of lists) {
    if (!l.name.trim()) out.push("a list needs a name");
    else if (l.name !== l.name.toLowerCase()) out.push(\`the list name "\${l.name}" must be lowercase\`);
    if (!l.label.trim() || !l.description.trim()) out.push(\`the list "\${l.name}" needs a label and a description\`);
  }
  return out;
}

it("the mailing lists are unique and lowercase", async () => {
  const { LISTS } = await import("../src/app/lists");
  expect(listProblems(LISTS)).toEqual([]);
});

it("the lists check fails with the reason", () => {
  const list = (name: string, label = "L", description = "D") => ({ name, label, description });
  expect(listProblems([list("news"), list("news"), list("Daily"), list(" "), list("tips", "", "D")])).toEqual([
    'the list "news" is declared twice',
    'the list name "Daily" must be lowercase',
    "a list needs a name",
    'the list "tips" needs a label and a description',
  ]);
});

`;

// --marketing on svelte (#113): the lists file, the consent module and its pure core, the schema, the subscribe, confirm and unsubscribe pages and their routes, and their tests.
// It implies --admin and --turnstile (so --email and --auth), which supply the sender, the Turnstile secret guard and widget helper, the same-origin check and the declarations test.
// The auth.ts parts (the two deletion paths) come from the composer. Runs after installAdmin and installPayments.
export function installMarketing(dir: string): void {
  cpSync(here, dir, { recursive: true, force: false, errorOnExist: true });
  editFile(dir, SCHEMA, (s) => replaceAnchor(s, 'export * from "./schema/admin";\n', 'export * from "./schema/admin";\nexport * from "./schema/marketing";\n', SCHEMA));
  editFile(dir, DECLARATIONS, (s) => {
    s = replaceAnchor(s, 'const LISTS = ["features", "settings", "onboarding", "plans"];', 'const LISTS = ["features", "settings", "onboarding", "plans", "lists"];', DECLARATIONS);
    return replaceAnchor(s, 'it("the checks fail with the reason", () => {', `${LIST_CHECKS}it("the checks fail with the reason", () => {`, DECLARATIONS);
  });
}
