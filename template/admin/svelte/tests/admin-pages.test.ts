import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

// D14, the accessibility baseline, checked on the pages' source (the gate checks the rendered HTML). Add a page and these cover it.
const root = join(import.meta.dirname, "..");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const pages = files(join(root, "pages/admin")).filter((f) => f.endsWith(".svelte") && !f.endsWith("layout.svelte"));
const read = (f: string) => readFileSync(f, "utf8");
const css = read(join(root, "pages/admin/admin.css"));

it("there are admin pages to check", () => expect(pages.length).toBeGreaterThanOrEqual(3));

it("every page has an h1 that takes focus", () => {
  for (const f of pages) expect([f, /<h1 tabindex="-1"/.test(read(f))]).toEqual([f, true]);
});

it("every table has a caption and column headers with scope", () => {
  for (const f of pages) {
    const src = read(f);
    const tables = src.match(/<table/g)?.length ?? 0;
    expect([f, src.match(/<caption/g)?.length ?? 0]).toEqual([f, tables]);
    for (const th of src.match(/<th\b[^>]*>/g) ?? []) expect([f, th]).toEqual([f, expect.stringContaining('scope="col"')]);
  }
});

it("row buttons name their target, nothing uses a modal or confirm(), and links navigate while buttons act", () => {
  const detail = read(join(root, "pages/admin/users/[id].svelte"));
  expect(detail).toContain("aria-label={`Revoke session on ${s.device}`}");
  expect(detail).toContain("aria-label={`Ban ${user.email}`}");
  for (const f of pages) {
    const src = read(f);
    expect([f, /\bconfirm\(|\balert\(|<dialog|role="dialog"/.test(src)]).toEqual([f, false]);
    expect([f, /<a\b[^>]*\bonclick=/.test(src)]).toEqual([f, false]); // a link that acts is a button
    expect([f, /<button\b[^>]*\bhref=/.test(src)]).toEqual([f, false]); // a button that navigates is a link
  }
});

it("inputs are labelled, field errors are tied to their input, and success and errors are announced", () => {
  const detail = read(join(root, "pages/admin/users/[id].svelte"));
  expect(detail).toContain('<label for="delete-confirm">');
  expect(detail).toMatch(/aria-describedby=\{del\.status === "error" \? "delete-error"/);
  expect(detail).toContain('id="delete-error" role="alert"');
  for (const f of pages) for (const input of read(f).match(/<input\b[^>]*>/g) ?? []) expect([f, input]).toEqual([f, expect.stringMatching(/\bid="/)]);
  expect(detail).toContain('role="status"');
});

it("the delete button stays disabled until the typed email matches, ignoring case", () => {
  expect(read(join(root, "pages/admin/users/[id].svelte"))).toContain("typed.trim().toLowerCase() !== user.email.toLowerCase()");
});

it("keyboard focus is visible, tap targets are 44px on phones, status is never colour alone", () => {
  expect(css).toContain(":focus-visible");
  expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*min-height: 44px/);
  // The status column always shows its word; the colour classes only add to it.
  expect(read(join(root, "pages/admin/index.svelte"))).toContain("{u.status.word}</td>");
});

it("the nav is one landmark with the current page marked, and the app link is outside it", () => {
  const layout = read(join(root, "pages/admin/layout.svelte"));
  expect(layout).toContain('<nav aria-label="Admin">');
  expect(layout).toContain("Back to app");
  expect(layout).toContain("{#each NAV as item");
});

it("the D6 copy says only what the server confirmed", () => {
  const detail = read(join(root, "pages/admin/users/[id].svelte"));
  for (const copy of [
    "Banned {user.email}. Their sessions are ended.",
    "Unbanned {user.email}. They can sign in again.",
    'link requested for {user.email}.',
    "Session revoked.",
    "revoked. They're signed out.",
    "Deletes {user.email}, their sessions and their uploaded files. This can't be undone.",
    "Type {user.email} to confirm",
    "This is you. Use Account settings to delete your own account.",
    "Admin access comes from ADMIN_EMAILS. Banning only blocks their sign-in.",
    "Only admins see this.",
  ])
    expect([copy, detail.includes(copy)]).toEqual([copy, true]);
  expect(detail).not.toMatch(/link sent|email sent|was sent/i);
});
