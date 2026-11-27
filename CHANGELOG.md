# Changelog

## Unreleased

- **`--marketing` (svelte, #113):** joining, confirming and leaving a mailing list, and deletion with the account. It implies `--admin` and `--turnstile` (so `--email` and `--auth`). A subscribe page checks Turnstile on the server and always answers "Check your inbox to confirm"; one plain-text confirmation mail per address per ten minutes goes through the existing sign-in sender, under an app-wide ceiling of 100 an hour; a confirm page changes nothing until its Confirm button is pressed (links last seven days); an unsubscribe page and a one-click route (`POST /api/lists/unsubscribe`, no sign-in, cookie or Origin) leave one list or everything, and "Subscribe again" mails a confirmation. Lists are declared in `src/app/lists.ts` (app-owned; ships `newsletter`); the consent module, its pure rules, routes, schema and tests are scaffold-owned. Deleting an account, by the user or by an admin, first removes its subscriber and consent rows, and a failed removal refuses the deletion with `SUBSCRIBER_REMOVAL_FAILED`. **No marketing mail is sent yet.** React, vue and solid output is unchanged. The `FEATURES` `requires` field now takes one key or several.
- **Generated tests (svelte, `--auth`, #132):** `tests/signed-in.ts` exports `signedIn({ admin?, email? })`, a verified signed-in user for tests that call the running dev server (set `DEV_URL`), with or without `--turnstile` and with no mail or captcha. It uses Better Auth's `testUtils` on the dev server's local database, in a test file only: nothing of it is in a deployed Worker, and the gate checks the build output. `tests/signed-in.test.ts` is the example; `AGENTS.md` documents it.
- **`AGENTS.md` (svelte, #133):** a "Dev server exits right after ready" note for the miniflare `#handleLoopback` assertion (a stray WebSocket from another tab): close the tab or run on another port with `--strictPort`; no `BETTER_AUTH_URL` change is needed. The default port stays 5173.
- **`AGENTS.md` (svelte, #143):** a "Keep SQL Postgres-ready" section: guidance for writing D1 code that is easier to move to Postgres (Neon) later. No code change.
- **Billing notices (`--payments`, #112):** the setup guide's human-only Stripe production step now lists the Stripe emails to switch on (receipts, renewal reminders, payment-confirmation links, failed payment, expiring card and trial-ending emails, the cancellation-confirmation automation, your own email domain) and says a Stripe sandbox sends none. Stripe sends these; the app sends no billing mail and no command can check the toggles. Apps without `--payments`, and react, vue and solid output, are unchanged.

## v0.6.0 (2026-11-25)

Run it with `bunx github:orloworks/zero-stack#v0.6.0 <dir>`. An app made with v0.5.0 or older needs the one-time port in `docs/upgrading.md` before `upgrade` works on it.

- **`upgrade` (svelte, #101):** `bunx github:orloworks/zero-stack#v<new> upgrade`, run in an app with a clean git tree, scaffolds the new version with the app's recorded flags and three-way-merges every file against a stored base copy. Untouched files are replaced, edited ones merged, conflicts left as markers with exit 1. It never commits and never touches `.env` or migrations. See `docs/upgrading.md`. React, vue and solid output is unchanged.
- **Breaking layout change for svelte apps:**
  - Every svelte app now commits `.zero-stack/manifest.json` and `.zero-stack/base.json` (what it was made from, and every generated file as written).
  - Scaffold-owned files start with a "Scaffold-owned by zero-stack" notice, and `AGENTS.md` says which files those are.
  - With `--admin`, the onboarding steps list moved to `src/app/onboarding.ts`; `src/onboarding.ts` imports and re-exports it, so no import changes.
  - With `--admin`, the feature list moved to `src/app/features.ts` and, with `--payments`, the plan list to `src/app/plans.ts`; with both, `PLAN_FEATURES` is declared in `src/app/features.ts`. `src/access.ts` and `src/plans.ts` import and re-export them, so no import changes (#105).
  - With `--admin`, the settings list moved to `src/app/settings.ts` (#103).
  - With `--auth`, `src/app/auth.ts` is where an app adds Better Auth plugins and trusted origins. A plugin that would replace a zero-stack endpoint, table, column or rate-limit rule, or weaken the listed sign-in settings, is refused at start with a message naming it. Origins must be exact (`https://host`), so wildcards and custom schemes are refused (#104).
  - A declarations test in every svelte app checks the lists in `src/app/` (names, duplicates, plan features that name an undeclared plan or feature). The lists may be emptied.
  - Port an older app once: see `docs/upgrading.md`.
- `upgrade` is no longer a valid app name.
- **`doctor`:** the R2 bucket is matched by its exact name, so a bucket whose name only starts the same no longer passes the check (#108).
- **Generated tests:** password-hashing tests have explicit timeouts and the email tests no longer depend on each other's order (#125).

## v0.5.0 (2026-11-24)

Run it with `bunx github:orloworks/zero-stack#v0.5.0 <dir>`.

- **`--payments` (svelte, needs `--auth`):** Stripe subscriptions on Better Auth's Stripe plugin, with Stripe-hosted Checkout and the Customer Portal.
  - **Plans** are declared by price lookup key in `src/plans.ts`, so the same code works in the sandbox and in live. `bun run stripe:seed` creates them in the sandbox and refuses live keys.
  - **Billing page** (`/billing`): subscribe, see the plan and its status (trial, cancelling, late payment, canceled), open the portal. A user with a late or unpaid subscription can't start a second Checkout.
  - **Webhook:** signed, exempt from rate limiting, and it writes Stripe's live state, not the event's snapshot, so a retried older event can't bring back a canceled subscription or an old plan. A failed write makes Stripe retry. While the webhook secret is still the placeholder, every event is refused.
  - **Gating:** `requirePlan` for routes and pages. With `--admin`, a feature can be on for chosen plans; the kill switch and a per-user override still win.
  - **Deleting a user** (self-service or by an admin) first expires their open Checkout sessions and cancels their subscriptions in Stripe, ahead of the file purge. If Stripe can't be reached, the deletion stops and nothing is removed.
  - **Admin** (with `--admin`): each user's page shows their plan, its status and its renewal, trial-end or end date, with a link to the customer in the Stripe dashboard. Refunds and plan changes stay in Stripe.
  - Not included: one-off purchases, team or seat billing, usage billing.
- **`bun run doctor` in every app:** runs `void env check`, a local migrations check and every setup step's own check, and prints PASS, FAIL or NOT CHECKED with a pointer to the step that fixes it. It reads names only, changes nothing, and stops a hung command after 30 seconds (`DOCTOR_LIMIT` changes this).
- **Account page:** a Sign out button in every svelte `--auth` app.
- **Admin fixes** from a browser QA pass: each setting's input is labelled with its key; the invite email names the app's host and says what to do; saving an unchanged setting writes no audit entry.
- **Agent tooling:** svelte apps get the Svelte MCP server in `.mcp.json`. `docs/upgrading.md` explains how to bring an older app forward.
- **Setup guide:** the email-sender step no longer passes when its config file is missing, and two steps that held `<placeholder>` text in their check now run as written.
- **Gate:** two new permutations, `svelte-payments` (with `--account-deletion`) and `svelte-payments-admin`; a fake Stripe over HTTP with signed webhooks. Payments has not yet been run against a real Stripe sandbox or a deployed Worker.

## v0.4.1 (2026-11-24)

Run it with `bunx github:orloworks/zero-stack#v0.4.1 <dir>`.

- **create-void 1.11.0** (was 1.8.0). Both version overrides are gone. better-auth stays on 1.7.x. Void's auth wiring now forwards cookies that `auth.api.*` calls in routes set (1.8.0 dropped them), and its cross-site cookie check is stricter: it now covers WebSocket upgrades.
- **Staying current:** `bun scripts/bump-void.ts` moves the pin to the latest create-void in one command, and lists what moved under it. `bun run ci` prints a one-line note when a newer create-void is out. It never fails.

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
