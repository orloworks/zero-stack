import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNotices, scaffoldOwned, withNotice } from "../../src/ownership";

// Paths of a real `--framework svelte` scaffold with every flag (probe, 2026-11-24).
const OWNED = [
  "auth.ts", "docs/setup.md", "middleware/10.admin.ts", "db/schema/admin.ts", "db/schema/invites.ts",
  "pages/admin/admin.css", "pages/admin/audit.server.ts", "pages/admin/audit.svelte", "pages/admin/features.svelte", "pages/admin/index.svelte",
  "pages/admin/invites.svelte", "pages/admin/settings.server.ts", "pages/admin/users/[id].server.ts", "pages/admin/users/[id].svelte",
  "routes/admin/users.ts", "routes/api/admin/features/[feature].ts", "routes/api/admin/invites.ts", "routes/api/admin/users/[id]/sessions/[sessionId]/revoke.ts",
  "routes/api/files/[name].ts", "scripts/doctor.sh", "scripts/secrets.ts", "scripts/setup-wizard.sh", "scripts/stripe-seed.ts",
  "src/access.ts", "src/admin.ts", "src/billing.ts", "src/lib/admin-action.ts", "src/lib/turnstile.ts", "src/mail.ts", "src/onboarding.ts", "src/rpc.ts", "src/settings.ts",
  "tests/access.test.ts", "tests/hello.test.ts", "tests/onboarding.test.ts",
];
const APP_OWNED = [
  "src/app/onboarding.ts", "pages/admin/layout.svelte", "pages/sign-in.svelte", "pages/sign-up.svelte", "pages/forgot-password.svelte", "pages/reset-password.svelte",
  "pages/settings.svelte", "pages/settings.server.ts", "pages/billing.svelte", "pages/billing.server.ts", "pages/index.svelte", "pages/index.server.ts", "pages/style.css",
  "routes/api/hello.ts", "routes/api/echo.ts", "routes/api/example-feature.ts", "routes/api/example-plan.ts", "routes/api/example-settings.ts",
  "package.json", "tsconfig.json", "vite.config.ts", "void.config.ts", "env.ts", "db/schema.ts", "db/seed.ts", "AGENTS.md", ".gitignore", ".mcp.json", "public/void.svg",
];

test("one rule names the scaffold-owned files of a real scaffold; everything else is app-owned", () => {
  for (const p of OWNED) expect([p, scaffoldOwned(p)]).toEqual([p, true]);
  for (const p of APP_OWNED) expect([p, scaffoldOwned(p)]).toEqual([p, false]);
});

test("the notice: line 2 under a shebang, an HTML comment before a svelte script, none for JSON", () => {
  expect(withNotice("scripts/doctor.sh", "#!/usr/bin/env bash\nset -e\n")!.split("\n").slice(0, 3)).toEqual([
    "#!/usr/bin/env bash",
    expect.stringMatching(/^# Scaffold-owned by zero-stack/),
    "set -e",
  ]);
  expect(withNotice("pages/admin/audit.svelte", "<script lang=\"ts\">\n</script>\n")).toMatch(/^<!-- Scaffold-owned by zero-stack[^]*? -->\n<script/);
  expect(withNotice("src/mail.ts", "export {};\n")).toMatch(/^\/\/ Scaffold-owned by zero-stack[^\n]*\nexport/);
  expect(withNotice("pages/admin/admin.css", "a {}\n")).toMatch(/^\/\* Scaffold-owned[^]*? \*\/\na/);
  expect(withNotice("some.json", "{}\n")).toBeNull();
  expect(withNotice("public/void.svg", "<svg/>")).toBeNull();
  // the one declaration file that exists says where steps go
  expect(withNotice("src/onboarding.ts", "x\n")).toContain("Declare onboarding steps in src/app/onboarding.ts.");
});

test("addNotices marks scaffold-owned files only, and leaves JSON, app-owned and skipped files alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "zs-own-"));
  const files: Record<string, string> = {
    "src/mail.ts": "export {};\n", "src/app/onboarding.ts": "export const STEPS = [] as const;\n", "pages/sign-in.svelte": "<p>hi</p>\n",
    "tests/data.json": "{}\n", "node_modules/x/src/y.ts": "x\n",
  };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
  addNotices(dir);
  const read = (p: string) => readFileSync(join(dir, p), "utf8");
  expect(read("src/mail.ts")).toContain("Scaffold-owned by zero-stack");
  for (const p of ["src/app/onboarding.ts", "pages/sign-in.svelte", "tests/data.json", "node_modules/x/src/y.ts"]) expect(read(p)).toBe(files[p]!);
});
