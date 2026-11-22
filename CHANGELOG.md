# Changelog

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
