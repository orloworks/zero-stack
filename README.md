# create-zero-stack

Scaffold a [Void](https://void.cloud) app for Cloudflare Workers with opinionated extras
(Tailwind, shadcn, zod RPC, auth and auth add-ons, storage). It wraps `create-void@1.8.0` (the pin in
`src/versions.ts`) and layers installers on top by anchored string replace. Personal-first
tool, published without support promises.

## Requirements

- [bun](https://bun.sh)
- Real Node `^24.22 || >=26.12` on `PATH` (Void needs it even when you run under bun)

## Usage

```sh
bunx github:orloworks/zero-stack#v0.3.0 my-app
```

It runs straight from this public GitHub repo at a release tag: no npm package, no login. Without `#<tag>` you get whatever is on `main`.

Run it without arguments in a terminal for prompts: after the project name it asks for the framework
(default svelte). Without a terminal and without `--framework` it builds react. The target directory
must be new or empty; on any failure, a directory it created is deleted, and a pre-existing empty one
is emptied. The CLI writes only inside that directory.

| Flag | Values | Notes |
|---|---|---|
| `--framework` | react (default without a terminal), vue, svelte (prompt default), solid | passthrough to create-void |
| `--tailwind` | bool | Tailwind v4 via `@tailwindcss/vite` |
| `--shadcn` | bool | React only, implies `--tailwind` |
| `--zod-rpc` | bool | Void `defineHandler.withValidator` with a zod body schema and a typed `void/client` call |
| `--auth` | bool | Void built-in Better Auth wiring, sign-in/up pages, migration, `.env` with a random secret |
| `--account-deletion` | bool | Svelte only, implies `--auth`. Delete-account section on the Account page, confirmed with the password (always required server-side) |
| `--email` | bool | Svelte only, implies `--auth`. Password reset and sign-up verification mail, dev inbox locally |
| `--turnstile` | bool | Svelte only, implies `--auth`. Cloudflare Turnstile on sign-up, sign-in and password reset |
| `--invite-only` | bool | Svelte only, implies `--email` and `--auth`. Only emails on the `SIGNUP_ALLOWLIST` secret (exact emails and `@domain` entries) can sign up, and they pick their password through a mailed set-password link, which also verifies the email (sign-in never waits on mail in other apps); a password sent with the sign-up is never kept; empty or missing list refuses everyone |
| `--admin` | bool | Svelte only, implies `--email` and `--auth`. An admin area at `/admin` for the users on the `ADMIN_EMAILS` secret (verified email, checked live on every request; everyone else gets a 404): search users, ban and unban, send a reset link, view and revoke sessions, delete a user with their files, and an audit log of every change; with `--invite-only`, invites live in the database (add an exact email or a whole domain, revoke, send an invite email) and `SIGNUP_ALLOWLIST` becomes optional; onboarding steps you declare in code show per user; feature switches you declare in `src/access.ts` (on, off or kill switch, with a per-user override) gate routes with `requireFeature`; typed runtime settings you declare in `src/settings.ts` (text, number with min and max, on/off, or a fixed set), read with `await setting("key")` and edited, with a reset to the default, on the Settings page |
| `--storage` | bool | Any framework, implies `--auth`. R2 per-user file routes (`/api/files/:name`) behind sign-in, purged on account deletion |

The starter is fixed to sqlite (D1). `--auth` on react, vue and solid is the same as in
v0.1.x. On svelte it also generates an Account page (`/settings`, change password) and a root
`auth.ts` composed from the add-ons you pick; each add-on documents itself in the generated
`AGENTS.md`.

## What gets generated

A `create-void` app (vite-plus toolchain, sqlite starter, git) plus your chosen installers,
`vp check --fix` applied, `trustedDependencies` for esbuild/workerd/sharp, and:

- scripts `verify`, `test`, `db:reset`, and one `vi.mock`-based route test
- `AGENTS.md` with a Cloudflare routing block and the rule to run `verify` before finishing
- `.mcp.json` with the Cloudflare Docs MCP

## Before you deploy

- `--turnstile`: `void secret put TURNSTILE_SECRET_KEY`, and set `VITE_TURNSTILE_SITE_KEY` in
  the build shell (`VITE_TURNSTILE_SITE_KEY=... void deploy`; builds ignore `.env`). Dev uses
  Cloudflare's test keys, and `auth.ts` refuses a test secret off localhost.
- `--invite-only`: set `SIGNUP_ALLOWLIST` for prod (`void secret put SIGNUP_ALLOWLIST`, or Infisical `prod`).
  Dev uses `@example.com` (a placeholder). A missing or empty list refuses every sign-up.
- `--admin`: set `ADMIN_EMAILS` for prod (`void secret put ADMIN_EMAILS`, or Infisical `prod`). Dev uses `@example.com`
  (a placeholder: replace it before real users arrive). Unset or empty means no admins and `/admin` answers 404. To use
  `/admin`, sign in with an email on `ADMIN_EMAILS` and verify it.
  With `--admin --invite-only`, `SIGNUP_ALLOWLIST` is optional: add invites on the Invites page, no secret change or restart.
- `--email`: set `email.from` in `void.config.ts` to an address on your mail domain (scaffolded
  as `noreply@example.com`); without a mail domain sends fail and are logged.
- Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` for the deployed origin.

Not included: data export, grace-period deletion, Stripe, orgs/admin/2FA (later waves), #17 referrals, #18 affiliate app.

## `--secrets infisical`

Implies `--auth`. Adds `bun run secrets:push` (one-time seed of the Infisical `dev` environment
from `.env`; overwrites Infisical values; prints only a key count) and `bun run secrets:pull`
(replaces `.env` from `dev`). Link the folder first (`secret-sync` skill or `infisical init
--project-id <id>`). `push` refuses names that break the key naming convention (upper snake
case, no `VITE_` name containing SECRET/PASSWORD/TOKEN/PRIVATE, never `VOID_`/`__VOID_`).
Both accept only a strict line format (blank, `#` comment, `KEY=value` with the value empty,
unquoted without `#`, quotes, backticks, `\` or `$`, or in one `"…"`/`'…'` pair with no quote, `\` or `$`
inside) in `.env` and the export, and refuse any other line by line number. Empty values are
pull-only: `push` refuses them, and whitespace-only quoted values, by line number, because Infisical rejects empty values. Both run under Bun
(`bun --no-env-file scripts/secrets.ts`, so `.env` never reaches the `infisical` CLI). Infisical
output is never printed. The generated `AGENTS.md` documents the production route (`void secret
sync` for server keys, which needs an `env.ts` declaring every synced key, skips `VITE_` and
`BETTER_AUTH_` lines and refuses any export line other than `KEY='…'`; `infisical run --env=prod -- void deploy` for client keys).

Out of scope: any network call from the scaffold CLI, Infisical's Cloudflare Workers sync (its
first sync overwrites Worker secrets), production or preview scripts, other secret managers,
writing `.infisical.yaml` or creating Infisical projects, `infisical run` for dev.

## Cloudflare routing

`docs/cloudflare-routing.md` maps a need to a Cloudflare product, the Void module (or
`cloudflare:` pass-through) and its docs. It is embedded in the generated `AGENTS.md`. To
use it as a user-level Claude skill from a clone of this repo:

```sh
bun run link-skill
```

It symlinks the skill into `~/.claude/skills/cloudflare-routing/`.

## No wrangler

Never create wrangler files. Void generates the Worker config and migrates a root
`wrangler.jsonc` into `void.config.ts` itself; extra bindings go under `cloudflare:`.

## Development

```sh
bun install
bun run setup-hooks   # pre-push runs `bun run ci`
bun run ci            # fast tier
bun run ci:full       # every permutation, before merge and publish
```

No GitHub workflow runs on push or pull request. Releases: see `docs/release-checklist.md`.

MIT
