# zero-stack — Spec V4 (wave 1: auth add-ons and storage)

`create-zero-stack` scaffolds a Void (Cloudflare Workers) app by wrapping the official
`create-void` and layering opinionated extras on top. Personal-first tool, published
publicly without support promises. Replaces the V3 blueprint.

## Repo

Single package, bun. No monorepo. MIT license.

```
src/
  index.ts          # entry: preflight, flags/prompts, run pipeline
  flags.ts          # flag parsing + fail-fast validation
  prompts.ts        # @clack/prompts, fills the same config object
  pipeline.ts       # create-void run, installers, install, failure cleanup
  versions.ts       # pinned create-void / void / dep versions (hand-bumped)
  installers/       # tailwind, shadcn, zodRpc, auth, auth-ts (composes auth.ts), account-deletion,
                    # email, turnstile, storage (anchored string replace)
template/           # file slices copied by installers
docs/cloudflare-routing.md   # single source, see Routing docs
tests/
```

## Pipeline

1. Preflight: spawn `node --version`, require `^24.22 || >=26.12` (Void needs real Node
   on PATH even under bun; `process.versions.node` is unreliable under bun).
2. Target dir must be new or empty. On any failure, delete a directory zero-stack created; a pre-existing empty target is emptied, not removed.
3. Validate flags, fail fast with a one-line fix. Implied flags are declared once in
   `FEATURES` (`src/flags.ts`) and each is announced: `--shadcn` enables `--tailwind`;
   `--account-deletion`, `--email`, `--turnstile`, `--storage` and `--secrets` enable `--auth`;
   `--invite-only` enables `--email` (and so `--auth`).
   `--shadcn` requires `--framework react`; `--account-deletion`, `--email`,
   `--turnstile` and `--invite-only` require `--framework svelte` (D33).
4. Run pinned `bunx create-void@<pin> <name> --toolchain vite-plus --framework <fw>
   --starter sqlite --deploy none --git`. It always installs and cannot be prevented.
5. Apply installers by anchored string replace against the known generated output of the
   pinned version. A missing anchor is a hard error (caught by tests on every pin bump).
6. Run `vp check --fix` in the new app: untouched `create-void@1.8.0` output fails its own
   `vp check` on formatting in 11 files (see `docs/facts.md`). Re-test on every pin bump.
7. Add `trustedDependencies: ["esbuild","workerd","sharp"]` to package.json (Void does
   not handle bun script approvals). Verified by the scaffold gate. Also write the `overrides`
   in `src/versions.ts` (today: pin `@cloudflare/vite-plugin`; see `docs/facts.md`).
8. Write the routing block into `AGENTS.md` and a `.mcp.json` with the Cloudflare Docs
   MCP (`https://docs.mcp.cloudflare.com/mcp`). Re-run `bun install` if deps changed.

## Flags

| Flag | Values | Notes |
|---|---|---|
| `--framework` | react (default), vue, svelte, solid | passthrough to create-void |
| `--tailwind` | bool | Tailwind v4 via `@tailwindcss/vite` (Void has no guidance) |
| `--shadcn` | bool | React only, implies `--tailwind` |
| `--zod-rpc` | bool | Void `defineHandler.withValidator` with a zod body schema + typed `void/client` call (no `@hono/zod-validator`: Void takes Standard Schema and feeds the client types) |
| `--auth` | bool | Void built-in Better Auth wiring, see below |
| `--account-deletion` | bool | Svelte only, implies `--auth`. Delete-account section on the Account page |
| `--email` | bool | Svelte only, implies `--auth`. Password reset and sign-up verification mail |
| `--turnstile` | bool | Svelte only, implies `--auth`. Cloudflare Turnstile on sign-up, sign-in and password reset |
| `--invite-only` | bool | Svelte only, implies `--email` and `--auth`. Sign-up limited to the `SIGNUP_ALLOWLIST` secret, with a verified email |
| `--storage` | bool | Any framework, implies `--auth`. R2 per-user file routes and helper |
| `--secrets` | `infisical` (the only value) | Any framework, implies `--auth`. `secrets:pull` / `secrets:push` against Infisical `dev`, see below |

Starter is fixed to sqlite (D1). The add-ons are the wave 1 and 1b flags; each CLI flag has a
matching prompt. `--auth` on react, vue and solid is unchanged from v0.1.x (D34): the
sign-in/sign-up pages, `void.config.ts` entry, alias, migration and `.env` below, and no
root `auth.ts`. On svelte, `--auth` also gains an Account page and a generated `auth.ts`. No `--ui none`; no API-only mode exists upstream.

## Auth installer

Add `auth` to `void.config.ts`, a minimal sign-in/sign-up page for the chosen framework,
the `@auth-schema` tsconfig alias, run `void db generate` so the migration is in the generated tree, ready for the user's first commit (create-void `--git` only runs `git init`),
and write a gitignored root `.env` with a random `BETTER_AUTH_SECRET` and
`BETTER_AUTH_URL=http://localhost:5173` (mode 0600; plus the Turnstile test secret with `--turnstile` and `SIGNUP_ALLOWLIST=@example.com` with `--invite-only`). No `.env.example`: Void 1.8.0 refuses
to start when one exists (`env.ts` is the key list). Void reads one
root `.env`; `.dev.vars` is unsupported. Social providers are out of scope.

## Wave 1 add-ons

Svelte `--auth` adds, beyond the sign-in/sign-up pages: the Account page `/settings`
(`pages/settings.svelte`, user from `pages/settings.server.ts`; change password, revokes other
sessions; no home-page link, `AGENTS.md` says to link it from the nav) and a root `auth.ts`
written whole by `composeAuthTs` (`src/installers/auth-ts.ts`) from the enabled features. Add-ons
contribute parts to that one file and edit pages at HTML-comment markers the svelte pages leave
(`zero-stack:sign-in-notice`, `sign-in-forgot-link`, `turnstile`, `account-deletion`); a missing
marker is a hard error like any anchor. Each add-on also appends a section to the routing block
in `AGENTS.md`.

- `--account-deletion` (svelte): Delete-account section on `/settings`, confirmed with the
  current password; the server always requires it (an `auth.ts` `before` hook returns 400 without
  one, since Better Auth skips the password for fresh sessions). `auth.ts` enables Better Auth `deleteUser`. `AGENTS.md` tells agents that
  every user-owned table must reference `user.id` with `onDelete: "cascade"`. Known limit: a
  social-only account has no password and cannot delete itself there.
- `--email` (svelte): `/forgot-password` and `/reset-password` pages, a "Forgot password?" link
  and "Password updated" notice on sign-in, reset (revokes other sessions) and sign-up
  verification mail. Sign-in does not wait on verification. Both mail callbacks call `send()` in
  generated `src/mail.ts` (Void `sendEmail`), which logs the error code and throws on failure;
  Better Auth swallows the throw, so the request still succeeds. It lives under `src/` because
  Void infers the email binding and the dev inbox only from scanned dirs, not root `auth.ts`.
  `void.config.ts` gets `email.from` = `noreply@example.com`. Dev mail lands in the inbox at
  `/__void/inbox`. Ships `tests/auth-email.test.ts` (asserts the failure path).
- `--turnstile` (svelte): Better Auth `captcha` plugin (Cloudflare Turnstile) in `auth.ts`
  guarding sign-up, sign-in and request-password-reset; `env.ts` (`TURNSTILE_SECRET_KEY`,
  `VITE_TURNSTILE_SITE_KEY`, default Cloudflare's always-pass test key); `src/lib/turnstile.ts`
  (`mountTurnstile`) widget helper; submit stays disabled until a token arrives; token sent in
  the `x-captcha-response` header. `src/turnstile-guard.ts` makes `auth.ts` refuse a test secret
  when `BETTER_AUTH_URL` is not localhost, and returns an empty secret when none is set so the
  build-time schema pass does not throw (captcha then fails closed). Local `.env` gets the test
  secret.
- `--invite-only` (svelte): `auth.ts` gains a Better Auth `databaseHooks.user.create.before` part
  that throws `APIError("FORBIDDEN", { code: "SIGNUP_INVITE_ONLY", message: "Signups are
  invite-only right now." })` unless `signupAllowed(env.SIGNUP_ALLOWLIST, user.email)`. The
  page, the raw API and any later sign-in method are all gated; a refused sign-up creates no
  user and sends no mail; existing users sign in as before. The gate checks a proven email, so
  it implies `--email` and sets `emailAndPassword.requireEmailVerification: true`: sign-up
  creates no session and an unverified user cannot sign in. This overrides D8 (sign-in never
  waits on mail) for invite-only apps only; others are unchanged. The sign-up page shows "Check
  your inbox to finish signing up." after an invited sign-up and after a refused one, so it never
  reveals who is on the list (with verification on, Better Auth answers a refused sign-up with a
  200 and a placeholder user, and the page also maps a 403 `SIGNUP_INVITE_ONLY` to the same
  copy). Password after verification: the inbox owner picks the password. The sign-up page asks
  for name and email only; an `invite-only` plugin in `auth.ts` (after the captcha plugin)
  replaces any sign-up password with a random one nobody sees, so a password sent before the
  inbox is proven (say, by a raw-API squatter) never signs in. On sign-up, a repeat sign-up and a
  sign-in for an unverified user, the plugin mails a "Set your password" link, a Better Auth
  reset token for the existing `/reset-password` page. There is no `emailVerification` config, so
  no plain verify link is ever minted. A valid reset token marks the email verified (a plugin
  hook before `/reset-password`), and the reset replaces the random password. Nothing is deleted,
  so a repeat sign-up can't lock the owner out; verified users are never touched. Unused links
  stay valid until they expire (an hour) and only ever reach the inbox. The sign-in page
  shows one message for `EMAIL_NOT_VERIFIED` and `INVALID_EMAIL_OR_PASSWORD`, so sign-in doesn't
  reveal list membership. The matcher refuses any email without exactly one `@`, with an empty
  local part, or with any non-ASCII character in the raw input (tested before trimming or
  lowercasing). `SIGNUP_ALLOWLIST` is a required
  server secret (`string()` in the composed `env.ts`): exact emails and `@domain` entries
  separated by commas or whitespace, case-insensitive; `@x.com` matches exactly that domain
  (not `sub.x.com` or `evilx.com`); a missing or empty list refuses everyone (Void's required-env check turns an unset or empty value into a 500 on every request; a list with no entries refuses every sign-up). Matcher
  `src/signup-allowlist.ts` ships with `tests/signup-allowlist.test.ts`. Local `.env` gets
  `SIGNUP_ALLOWLIST=@example.com`. `env.ts` is composed from the enabled features
  (`src/installers/env-ts.ts`); no feature copies one. Going public means scaffolding or
  editing without the gate, never emptying the list.
- `--storage` (any framework): `src/storage.ts` (per-user keys `users/<id>/<name>` that reject
  escaping names, `purgeUserFiles`) and `tests/storage.test.ts`. With auth (always, via the
  implied flag) `routes/api/files/[name].ts` adds PUT (streamed, needs Content-Length), GET
  and DELETE of the signed-in user's own files, each behind `requireAuth`. No route ships
  without auth. With `--account-deletion`, `auth.ts` purges the user's files in `beforeDelete`
  (fail closed: a storage error aborts the deletion, code `STORAGE_PURGE_FAILED`, shown by the
  page as partial-purge copy) and sweeps again in `afterDelete`.

Void imports `void/email` and `void/storage` lazily in generated helpers: its plugin loads
`auth.ts` at startup and at build time, where a top-level import fails under `vp test`.

### Before you deploy

- `--turnstile`: `void secret put TURNSTILE_SECRET_KEY` (real secret), and set
  `VITE_TURNSTILE_SITE_KEY` in the build shell (`VITE_TURNSTILE_SITE_KEY=... void deploy`;
  builds ignore `.env`). Shipping the default site key is a test key.
- `--invite-only`: set `SIGNUP_ALLOWLIST` for prod (`void secret put SIGNUP_ALLOWLIST`, or Infisical
  `prod` through the production route); dev uses the `@example.com` placeholder.
- `--email`: set `email.from` in `void.config.ts` to an address on your mail domain; production
  delivery needs that domain (or Workers Paid on your Cloudflare account). Without it sends
  fail, are logged, and the user gets no mail.
- Always: `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` for the deployed origin.

## `--secrets infisical`

Implies `--auth`. The scaffold never calls Infisical and works offline. It copies a
dependency-free `scripts/secrets.ts` (`node:` APIs only) and adds `secrets:pull` and
`secrets:push`; `.env` and `.env.pull-tmp` are gitignored. Both commands need a link file
(`.infisical.yaml`, or legacy `.infisical.json`), which the owner's `secret-sync` skill or
`infisical init --project-id <id>` creates; the scaffold writes neither.

- `secrets:push`: `infisical secrets set --file .env --env=dev --silent`, a one-time seed that
  overwrites Infisical values. Prints only the key count, on exit 0. Refuses before calling
  Infisical when a `.env` name breaks key naming rule 1, 5 or 6. On failure: exit 1,
  `infisical exited <code>`, a note that some keys may already be set, and the command to rerun.
- `secrets:pull`: replaces `.env` with the `dev` environment, verbatim, mode 0600; refuses an
  export lacking any key the current `.env` has.
- Infisical's stdout and stderr are captured and never printed.
- Key naming convention: upper snake case `^[A-Z][A-Z0-9_]*$`; one name in `env.ts`, `.env`,
  every environment and the Worker; provider prefix first; `VITE_` names are public and never
  contain SECRET, PASSWORD, TOKEN or PRIVATE; never `__VOID_` or `VOID_`; `env.ts` lists every
  app key except Void-owned `BETTER_AUTH_*`.
- Production (documentation in AGENTS.md, no script): server keys via `infisical export
  --env=prod` minus `VITE_` and `BETTER_AUTH_` lines (Void creates `BETTER_AUTH_SECRET` on deploy)
  into a private `mktemp` file, then `void secret sync "$f" --yes`, skipped when the filtered file
  is empty; every step exits 1 on failure so a failed export never deploys; client keys via
  `infisical run --env=prod -- void deploy`. `void secret sync` needs an `env.ts` declaring
  every synced key (AGENTS.md says so).
- Strict line format, no dotenv parser: push (`.env`) and pull (the export and the local `.env`)
  accept only blank lines, `#` comments and `KEY=value` with no spaces around `=`, the value
  empty, unquoted (no `#`, quote, backtick, `\` or `$`, no edge whitespace) or one `"…"` or `'…'` pair
  with no quote, `\` or `$` inside (Void dev expands `$` in `.env`, even in single quotes). Any other line (multi-line values, `export `, inline comments,
  escapes, CRLF, a lone carriage return in a value) is refused as `line <n>` (`export line <n>`, `.env line <n>` for pull), never its
  text. Names come only from accepted lines. Empty values are pull-only: push refuses `K=`, `K=""`,
  `K=''` and whitespace-only quoted values (`K=" "`, which Infisical trims) by line number before any `infisical` call ("Infisical rejects empty values; remove the
  line or give it a value"), because `infisical secrets set --file` rejects the whole file. The scripts run under Bun with `--no-env-file` (`bun --no-env-file scripts/secrets.ts`), so `.env` never reaches the `infisical` child (an `INFISICAL_*` key there would redirect it).
- The production route refuses (exit 1, before sync and deploy) a prod export with any line other
  than `KEY='…'` with no `'`, `\`, `$` or carriage return inside. Pull and the route also refuse an export with a blank, `#` or repeated-name line: Infisical's export does not escape values, so a value holding `'` and a newline can add a line that overrides another key.
- Out of scope: any network call from the scaffold CLI, Infisical's Cloudflare Workers sync (its
  first sync overwrites Worker secrets), production or preview scripts, other secret managers,
  writing `.infisical.yaml` or creating Infisical projects, `infisical run` for dev.

## Generated app

Scripts: `verify` (`void prepare && vp check && tsc --noEmit && vp build && vp test`), `test`,
`db:reset` (`void db reset --yes`). Ships one `vi.mock`-based route test (Void tests run
in Node; bindings are unavailable). `AGENTS.md` tells agents to run `verify` before
finishing. No wrangler files, ever (Void migrates a root `wrangler.jsonc` itself).

## Routing docs

One source, `docs/cloudflare-routing.md`: need -> product -> Void module or `cloudflare:`
pass-through -> docs URL, with a status column (`verified` / `unverified — read docs
first`) and the Void version it was checked against (1.8.0). Hand-regenerated on pin
bump. Preamble rules: check `node_modules/void/docs/` and the table before raw Wrangler
config; for Containers requests look at `void/sandbox` first (needs Workers Paid and
Docker); brownfield apps use Void's `migrate-vite-cloudflare-to-void` skill.
Destinations: fenced block in generated `AGENTS.md`, and a user-level skill symlinked by
`bun run link-skill` into `~/.claude/skills/cloudflare-routing/` (the CLI never writes
outside the target directory).

## Testing and CI

Local is the gate. No GitHub workflow on push or PR; the only workflow is a
`workflow_dispatch` release.

- `bun run ci` (fast, pre-push, ~30s): flag-validation unit tests, plus one scaffold of
  the full react permutation with `vp check`, `vp build`, and `GET /` against `vp dev`
  (the starter page reads D1). The svelte paths are not in it; run
  `bun scripts/gate.ts --framework svelte <flags>` for them.
- `bun run ci:full` (before merge and publish): all permutations, at most 2 at once under
  `nice`, shared bun cache, scaffolds skipped when the hash of pins + template is
  unchanged. The matrix (`scripts/matrix.ts`) is every framework with all its valid flags,
  bare, and solo runs per add-on: `svelte-auth`, `svelte-account-deletion`, `svelte-email`,
  `svelte-turnstile`, `svelte-invite-only`, `storage`, `svelte-storage-deletion`, `tailwind`, `zod-rpc`.
- Gate checks per flag (`scripts/gate.ts`, HTTP against `vp dev`): `--auth` sign-up, sign-in,
  session, `/settings` signed in and out, wrong then right change-password, other session
  revoked, migration present, `.env` gitignored; `--email` reset mail in the dev inbox, link,
  new password signs in, bad or used token rejected, earlier sessions revoked;
  `--turnstile` sign-up, sign-in (and reset) refused without a token, accepted with the dummy
  token; `--invite-only` @example.com admitted (any case) with no session and no kept password
  until the dev-inbox set-password link is followed; in both orders (attacker first, owner
  first) a raw-API attacker's password P is refused (the sign-in mails another set-password
  link), the owner sets Q through a link, then P gets 401 and Q 200, no verify link is ever
  mailed, a later sign-up over the verified user changes nothing; lookalike domain
  and subdomain leave no user row and no mail, an exact entry admits and a
  same-domain address is refused, an empty list refuses everyone, existing users still sign
  in (the list is changed by restarting the dev server on a new `.env`); `--account-deletion` missing/empty password 400, wrong password rejected, right password deletes; `--storage` 401
  without a session, upload and download under `users/<id>/`, escaping names rejected (keys
  read back from the local R2 state), object gone after account deletion. The
  `STORAGE_PURGE_FAILED` path is covered by string tests only, not over HTTP.
- Each wave also gets one manual svelte `/qa-only` browser pass (gstack browse) on the
  generated app, run by the controller before merge, not by the gate.
- No Playwright in the gate. gstack browse may be recommended in generated `AGENTS.md` for agents to
  eyeball UI changes, never in the gate.

## Milestones

- M1: pipeline, preflight, flag validation, cleanup, `create-void` invocation, `ci`.
- M2: tailwind, shadcn, zod-rpc, auth installers, generated scripts and test, `ci:full`.
- M3: routing doc, `AGENTS.md` block, `.mcp.json`, `link-skill`. Manual `npm publish`
  of `create-zero-stack` v0.1.0 only after `ci:full` is green.

## Non-goals for v0.1.0 (revisit in v0.2)

AI / Durable Object installers (R2 storage and Turnstile shipped in wave 1), `add` and brownfield `migrate`
commands (Void already ships `void init` for existing apps and a migration skill),
`--json`, MCP server, telemetry, docs site, vendored skills, Renovate/Changesets,
pnpm/npm support, Playwright, magicast, rollback tracker, `void-stack.json`.

## Non-goals for wave 1

Data export, grace-period (soft) deletion, Stripe/billing, add-ons for react/vue/solid (D33:
only `--storage` and `--secrets` are framework-agnostic), social providers, and the rest of the roadmap: wave 2
(orgs, admin, 2FA), #17 referrals, #18 affiliate.

## Open facts to verify during build

Bun script trust for workerd/esbuild; `vp install` behaviour with `bun.lock`; whether
`bun create` sets the bun user agent; `cloudflare:` pass-through deploys; custom Worker
exports (Workflows, Agents SDK, Containers) under Void.
