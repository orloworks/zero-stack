import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

// D14 on the Invites page, checked on its source (admin-pages.test.ts covers the shared rules for every page; the gate checks the rendered HTML).
const root = join(import.meta.dirname, "..");
const page = readFileSync(join(root, "pages/admin/invites.svelte"), "utf8");

it("the radio choice is a labelled group, the field's error is tied to it, and the domain preview is announced by the field", () => {
  expect(page).toContain("<legend>Invite</legend>");
  expect(page).toContain('<label for="invite-value">');
  expect(page).toContain('aria-describedby={error ? "invite-error"');
  expect(page).toContain('id="invite-error" role="alert"');
  expect(page).toContain('id="invite-preview"');
  expect(page).toContain("Exact email");
  expect(page).toContain("Whole domain");
});

it("row buttons name their target, and the secret list says where to change it", () => {
  expect(page).toContain("aria-label={`Revoke ${i.entry}`}");
  expect(page).toContain("aria-label={`Send invite email to ${i.entry}`}");
  expect(page).toContain("From the SIGNUP_ALLOWLIST secret (edit the secret to change)");
  expect(page).toContain("Invites you add here appear below.");
});

it("success and notes come from the server's reply, in status regions", () => {
  expect(page).toContain("<p role=\"status\">{said.message}</p>");
  expect(page).toContain("{#each said.notes as note");
  expect(page).not.toMatch(/link sent|email sent|was sent/i);
});
