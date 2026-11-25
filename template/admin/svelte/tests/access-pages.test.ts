import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

// D14 and D15 on the Features page and the overrides section, checked on their source (the gate checks the rendered HTML).
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const page = read("pages/admin/features.svelte");
const detail = read("pages/admin/users/[id].svelte");

it("each feature is a fieldset radio group with its own Save, and the copy says what each state does", () => {
  expect(page).toContain("<fieldset>");
  expect(page).toContain("<legend");
  expect(page).toContain('type="radio"');
  for (const copy of ["Everyone, except users set to off", "No one, except users set to on", "No one. User settings are ignored.", "Kill switch"]) expect([copy, page.includes(copy)]).toEqual([copy, true]);
  expect(page).toContain("aria-label={`Save ${f.name}`}");
  expect(page).toContain("Nothing declared yet. Add features in <code>src/app/features.ts</code>.");
  expect(page).toContain("{SAVED}");
  expect(read("src/lib/admin-display.ts")).toContain("Saved. Applies on the user's next page load.");
});

it("success is a status and a failure an alert, both announced", () => {
  expect(page).toContain('role="status"');
  expect(page).toContain('role="alert"');
  expect(detail).toMatch(/role="status">\{SAVED\}/);
});

it("user detail has a labelled select per feature with Use global, On and Off, and the effective result and reason", () => {
  expect(detail).toContain("<label for={`override-${f.name}`}>");
  expect(detail).toContain('<option value="default">Use global</option>');
  expect(detail).toContain('<option value="on">On</option>');
  expect(detail).toContain('<option value="off">Off</option>');
  expect(detail).toContain("Effective: {f.effective}");
  expect(detail).toContain("aria-label={`Save ${f.name} for ${user.email}`}");
  expect(detail).toContain("Nothing declared yet. Add features in <code>src/app/features.ts</code>.");
});

it("the pages take the effective result from access.ts and keep no precedence of their own", () => {
  const loader = read("pages/admin/users/[id].server.ts");
  expect(loader).toContain("sw.effective(name).reason");
  for (const src of [loader, read("pages/admin/features.server.ts"), page, detail]) expect(src).not.toMatch(/\bkill\b.*(===|!==)|(===|!==)\s*"kill"|\bdecide\b|\bresolve\b|\.plan\.has|\bfeaturesForPlan\b|\bcurrentPlan\b|\brequirePlan\b/);
});
