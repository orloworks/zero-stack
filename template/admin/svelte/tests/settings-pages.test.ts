import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

// D14 and D16 on the Settings page, checked on its source (the gate checks the rendered HTML).
const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const page = read("pages/admin/settings.svelte");

it("each setting is its own form with a label, its description, its default and its own Save", () => {
  expect(page).toContain("<form novalidate");
  expect(page).toContain("{s.description}");
  expect(page).toContain("Default: {s.defaultText}");
  expect(page).toContain("aria-label={`Save ${s.key}`}");
  expect(page).toContain("aria-label={`Reset ${s.key} to default`}");
  expect(page).toContain("Reset to default");
  expect(page).toContain("{#if s.canReset}");
  expect(page).toContain("Nothing declared yet. Add settings in <code>src/app/settings.ts</code>.");
  expect(page).toContain("Stored value is invalid; using the default.");
  expect(page).toContain("{SAVED}");
});

it("the editor fits the type: a checkbox plus Save, a number with min and max, a select, a text input", () => {
  expect(page).toContain('type="checkbox"');
  expect(page).toContain('type="number" min={s.min ?? undefined} max={s.max ?? undefined}');
  expect(page).toContain("<select");
  expect(page).toContain('type="text"');
  // A checkbox never saves on tap: the only submit is the Save button.
  expect(page).not.toMatch(/onchange|oninput|onclick=\{\(\) => save/);
});

it("labels, a status on success and an inline alert tied to the field on failure", () => {
  expect(page).toContain("<label for={s.key}>{s.key} value</label>");
  expect(page).toContain('role="status"');
  expect(page).toContain('role="alert"');
  expect(page).toContain('aria-invalid={failure(s.key) ? "true" : undefined}');
  expect(page).toContain("-error");
  expect(read("src/lib/admin-display.ts")).toContain("Saved. Applies on the user's next page load.");
});

it("the page parses nothing itself: the server validates and the page shows its message", () => {
  expect(read("pages/admin/settings.server.ts")).toContain("adminSettings(c).list()");
  expect(page).not.toMatch(/parseSetting|resolveSetting/);
});
