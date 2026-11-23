// Hand-bumped. Bumping requires `bun run ci:full`.
export const CREATE_VOID = "1.8.0";
export const NODE_RANGE = "^24.22 || >=26.12";
export const TAILWIND = "4.3.5"; // tailwindcss and @tailwindcss/vite share a version
export const ZOD = "4.6.7"; // Void's own dev pin; zod is an optional peer of void
// The --admin tests import these directly; same ranges as void@1.8.0 so one copy installs.
export const ADMIN_TEST_DEV_DEPS = { "better-sqlite3": "^13.0.3", "drizzle-orm": "^0.45.4" };
export const CLASS_VARIANCE_AUTHORITY = "0.7.1";
export const CLSX = "2.1.1";
export const TAILWIND_MERGE = "3.7.0";

// Void does not handle bun script approvals; the generated package.json trusts these (gate asserts it).
export const TRUSTED_DEPENDENCIES = ["esbuild", "workerd", "sharp"];

// void@1.8.0's `^2.0.0-beta.v.15` range picks @cloudflare/vite-plugin@2.0.0-rc.0 (2026-11-16), which writes
// Build Output v1 while void's build-output-utils@0.9 reads v0, so `vp build` fails. Drop on the next void pin.
// vite-plus@1.7.0 (2026-11-17) expects @voidzero-dev/vite-plus-core@8.3.8000, but create-void's
// `vite: npm:@voidzero-dev/vite-plus-core@^1.6.0` can't reach it, so `vp build` fails. Drop on the next void pin.
export const OVERRIDES = { "@cloudflare/vite-plugin": "2.0.0-beta.v.17", "vite-plus": "1.6.0" };
