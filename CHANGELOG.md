# Changelog

## v0.4.0 (2026-11-23)

Run it with `bunx github:orloworks/zero-stack#v0.4.0 <dir>`.

- **`--admin` (svelte):** an admin area at `/admin` for verified users on `ADMIN_EMAILS`.
  - **Users:** search, ban and unban, revoke sessions, send a reset link, remove a user (files purged first).
  - **Audit log:** every admin change writes exactly one entry.
  - **Invites** (with `--invite-only`): invites live in the database, by exact email or whole domain, and apply at once with no restart. `SIGNUP_ALLOWLIST` becomes optional.
  - **Onboarding:** steps are declared in code, with "n of m" progress.
  - **Feature switches:** global and per-user, with a kill switch (`src/access.ts`).
  - **Settings:** typed runtime settings, with reset (`src/settings.ts`).
  - The generated app declares `better-sqlite3` and `drizzle-orm` as devDependencies, because its tests import them.
- **Setup guide in every app:** a `## Setup` table in AGENTS.md and `docs/setup.md`, with each step marked as agent, agent with browser, or human. `scripts/setup-wizard.sh` covers the human-only steps. It stores values in Void or Infisical, never echoes them and never opens a browser.
- **Security and correctness:**
  - auth rate limits are shared across Worker instances (stored in D1);
  - a failed invite mail is rolled back so it can be retried;
  - uploads are capped at 10 MB (413).
- **CLI:** in an interactive run with no `--framework`, it asks for one (default svelte). Non-interactive runs are unchanged.
- **Gate:** retries the known install and dev-proxy flakes once, and nothing else.

## v0.3.0 (2026-11-22)

This is the first tagged release. Run it with `bunx github:orloworks/zero-stack#v0.3.0 <dir>`.

- **Svelte-first add-ons:**
  - an account page, with password change and other sessions revoked;
  - `--account-deletion`, which also purges the user's R2 files;
  - `--email`, adding reset-password mail via Void;
  - `--turnstile`, for sign-up, sign-in and reset;
  - `--storage`, for per-user R2 files.
- **`--secrets infisical`:** pulls and pushes `.env` through Infisical, with a strict line format, and adds a production route to `void secret sync`.
- **`--invite-only`:** only addresses on `SIGNUP_ALLOWLIST` can sign up. The inbox owner sets the password through an emailed link, and the list is checked again at that point. Responses look the same for invited and uninvited addresses.
- **`env.ts`** is composed from the enabled features.
- **Fixes since v0.1:** signal cleanup, an honest `ci:full` cache, installer and gate gaps, a pre-push hook that no longer flips `core.bare`.

## v0.1.0

This version was never tagged or published. It added the scaffolder for react, vue, svelte and solid, with tailwind, shadcn, zod-rpc and auth.
