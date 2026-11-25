# zero-stack — Spec V4 (wave 1: auth add-ons and storage; wave 2: admin)

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
                    # email, turnstile, invite-only, admin, storage (anchored string replace)
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
   `--invite-only` and `--admin` enable `--email` (and so `--auth`).
   `--shadcn` requires `--framework react`; `--account-deletion`, `--email`,
   `--turnstile`, `--invite-only` and `--admin` require `--framework svelte` (D33).
4. Run pinned `bunx create-void@<pin> <name> --toolchain vite-plus --framework <fw>
   --starter sqlite --deploy none --git`. It always installs and cannot be prevented.
5. Apply installers by anchored string replace against the known generated output of the
   pinned version. A missing anchor is a hard error (caught by tests on every pin bump).
6. Run `vp check --fix` in the new app: untouched `create-void` output fails its own
   `vp check` on formatting in 11 files (see `docs/facts.md`). Re-test on every pin bump.
7. Add `trustedDependencies: ["esbuild","workerd","sharp"]` to package.json (Void does
   not handle bun script approvals). Verified by the scaffold gate. Also write the `overrides`
   in `src/versions.ts` (empty since create-void 1.11.0; see `docs/facts.md`).
8. Write the routing block into `AGENTS.md` and a `.mcp.json` with the Cloudflare Docs
   MCP (`https://docs.mcp.cloudflare.com/mcp`). Re-run `bun install` if deps changed.
9. Svelte only (react, vue and solid output is unchanged, byte for byte). The formatting run of step 6 happens last, after step 8 and the setup files; around it:
   before it, add the notice to every scaffold-owned file (`src/ownership.ts`: one path rule; a comment on line 1, on line 2 under a shebang, an HTML comment in a svelte or markdown file; none in JSON)
   and add `.zero-stack/upgrade-tmp` to the app's `.gitignore`; after it, write `.zero-stack/manifest.json` and `.zero-stack/base.json` (`src/manifest.ts`).

## Upgrade seam (svelte; spec #100, ADR 0001 and 0002)

- **Manifest** (`.zero-stack/manifest.json`): `formatVersion` (1), `zeroStack` (the version), `config` (exactly what `scaffold()` takes: name, framework, every flag) and
  `migrations` (sha256 of `db/migrations/*.sql` in name order, null with none). The SQL is byte-identical between two scaffolds; names, timestamps and the journal differ, so only the SQL is hashed (`docs/facts.md`).
- **Base copy** (`.zero-stack/base.json`): every generated file by path as `{ mode, encoding, content }` (`utf8`, or `base64` for binary), as zero-stack wrote it after formatting.
  One fixed skip list (`skipped` in `src/manifest.ts`): `.env` and `.env.*`, `node_modules`, `.git`, `dist`, `.void`, `.void-wrangler.jsonc`, `.wrangler`, `.cloudflare`,
  `bun.lock`, `db/migrations`, `*.tsbuildinfo`, `.DS_Store`, and `.zero-stack/` itself. Both files are `JSON.stringify(_, null, 2)` so `vp check` (which scans the folder) passes.
- **Ownership** (`scaffoldOwned` in `src/ownership.ts`): scaffold-owned are `auth.ts`, `src/` except `src/app/`, `pages/admin/` except `layout.svelte`, `routes/admin/`,
  `routes/api/admin/`, `routes/api/files/[name].ts`, `middleware/10.admin.ts`, `db/schema/`, `tests/`, `scripts/` and `docs/setup.md`. Everything else is app-owned.
  Ownership is a label (the notice, `AGENTS.md`, the report); it does not decide what an upgrade overwrites.
- **`upgrade`** (`bunx github:orloworks/zero-stack#v<new> upgrade`, in the app; `upgrade` is not a valid app name; no options). Refuses, changing nothing, with no manifest, outside a git
  work tree, or with uncommitted or untracked changes. Scaffolds the running version with the manifest's configuration into `.zero-stack/upgrade-tmp/<name>` (removed first if
  left over, and always after), decides every file from (the app's file, the base copy, the new version's copy), then writes: untouched, replaced (new file mode); unchanged upstream, left; both changed,
  `git merge-file` with labels `your app` / `zero-stack <old> (your last upgrade)` / `zero-stack <new> (new)`, conflicts left as markers, listed, exit 1; new, written when the path is free and merged against an empty base when not;
  removed upstream, deleted when untouched and kept when edited; deleted by the app, stays deleted; binary changed on both sides, a file/folder clash, or a path through a symlinked folder: kept, listed and counted as a conflict (exit 1). Refuses `core.autocrlf=true`, a symlinked `.zero-stack` or record file, and, before scaffolding, any recorded path on the skip list (compared without regard to case), with a backslash, a NUL or a part ending in a dot or space. Any symlink at a path or on its way makes the path "kept (outside your app)" or "not a file in your app". Modes recorded are only the executable bit; only replaced and added files are chmodded. A merge error aborts before any write.
  It then replaces the manifest and base copy with the new scaffold's and prints one line per changed file, then a summary: `Summary: n replaced, n added, n removed, n merged, n kept, n in conflict.`; a line `You edited <path>, which zero-stack owns.` plus the app-owned file where the change belongs (`src/app/settings.ts`, `src/app/onboarding.ts`, `src/app/auth.ts`, else a pointer to `AGENTS.md`) for every merged, conflicted or kept scaffold-owned file the app edited; `package.json changed: run \`bun install\`.` (or, with `package.json` in conflict, `package.json is in conflict: resolve it, then run \`bun install\`.`); the `void db generate` reminder when the migration hash changed; and last, whenever anything was written, the two undo commands (`git checkout .`, `git clean -fd`). An app already current prints `Nothing to do: your app is already current.` and exits 0, with no undo commands. The record files are rewritten only when their bytes differ: when only they changed, it prints `No file of yours changed; .zero-stack/ now records the new version.` and the undo commands. Two recorded paths that differ only by case are refused with their own message.
  It never commits, never touches `.env` or migrations, and writes only inside the app (a recorded path with `..` or an absolute path is refused).
- **Gate** (`svelte-upgrade` in `scripts/matrix.ts`; the gate-only flag `--upgrade`; logic in `scripts/gate.ts`, so the `ci:full` hash covers it): scaffold, edit `src/app/onboarding.ts` and a setting in `src/app/settings.ts` (dropping `routes/api/example-settings.ts`, which that orphans), age the app four ways,
  run the upgrade, assert exit 0, no conflict, scaffold-owned files and `.zero-stack/` equal to a fresh scaffold's, the edit intact, and `bun run verify` green.
- **Cross-version gate** (`svelte-upgrade-baseline`; gate-only flag `--baseline`): scaffolds `UPGRADE_BASELINE` (`src/versions.ts`, so the `ci:full` hash covers it; a commit sha until a release tag writes a manifest, then that tag)
  from GitHub with `bun x github:orloworks/zero-stack#<baseline>`, edits `src/app/onboarding.ts`, upgrades with the working tree's code, and asserts at least one replaced, added, removed or merged line (a baseline equal to this tree fails as "too new"), exit 0, no conflict, the edit intact and `bun run verify` green. It needs the network: a failed fetch or scaffold fails the run with a clear message, never a pass.
- **Auth extension** (svelte with auth; `src/app/auth.ts`, app-owned, written once; guards in `src/auth-extension.ts`, scaffold-owned; test `tests/auth-extension.test.ts`; #104). The app adds Better Auth plugins and trusted origins
  without editing `auth.ts`. `src/app/auth.ts` exports a function of the env that returns exactly `{ plugins, trustedOrigins }`, both empty when scaffolded; its opening comment states the lazy-import rule (database, mail and
  storage modules are imported inside functions, never at the top), that hooks go in a plugin of the app's own, and the known limits. The composed `auth.ts` imports it, calls it once, passes zero-stack's plugin list and the result to
  `extendAuth`, and uses the returned `plugins` (the app's after all of zero-stack's, so captcha stays first) and `[...defaults.trustedOrigins, ...app origins]`. The app's object is never spread into the options, so no option
  zero-stack sets (hooks, database hooks, `user`, email and password, `rateLimit`) can be replaced. React, vue and solid keep today's `auth.ts` byte for byte, and have no extension.
  `extendAuth` throws, naming the plugin and the reason (at startup and at build, where `defineAuth`'s function runs), when: the extension returns any other key (or a non-array); an app plugin's id equals one of zero-stack's;
  an app plugin defines an endpoint whose key or path (compared without case, trailing slash or parameter names) is taken by Better Auth's core or by one of zero-stack's plugins (pinned Better Auth 1.7.28: `getEndpoints`
  spreads `plugin.endpoints` over the core table, and a later plugin over an earlier one, so a same-key endpoint replaces `deleteUser`, skipping the cancel-before-delete and the purge; `checkEndpointConflicts` only logs a path clash);
  or an app plugin's `init` returns a context, or any option but `databaseHooks` and `trustedOrigins` (`runPluginInit` merges the rest with `defu(options, rest)`, filling what zero-stack left unset, such as the email-verification
  settings invite-only leaves out on purpose; a returned `context` is `Object.assign`ed over the real one, replacing the password hasher or the adapter). The `init` check runs when Better Auth builds its context, so a refusal
  fails the first auth request (and every one after) with the message; it does not run at build. The taken keys and paths are read at startup from Better Auth's own endpoint table (`getEndpoints` from `better-auth/api`), never a list
  kept here. Only the app's plugins are wrapped (a copy, so what is checked is what runs; `init` returns a fresh object holding only the allowed options) and checked.
  Also guarded (#104 fix round): every app origin, from the extension and from an `init`, must be a plain origin (`new URL(o).origin === o`, no `*` or `?`; a list, never a function), so a typo fails at startup instead of never
  matching; Void's default `trustedOrigins`, when present, must be a list of strings, and `extendAuth` returns defaults plus the app's; a plugin `schema` may add fields and models but not a field its model already has in Better Auth
  (`getAuthTables` from `better-auth/db`, read once at load) or in a zero-stack plugin; a plugin's `rateLimit` rules are wrapped so they never match a path Better Auth or zero-stack owns (`dist/api/rate-limiter/index.mjs`,
  `resolveRateLimitConfig`: a matching plugin rule beats the default rule, then `customRules` apply, so the Stripe webhook exemption holds); an `init` that changes `ctx.password`, `ctx.adapter` or the option names of its argument is
  refused; repeated slashes are collapsed when comparing paths. Better Auth's table is built once at module load; zero-stack's plugins are added per call.
  Known limits, in the extension file's comment and in `AGENTS.md`: the guards stop replacement by declaration, not a plugin whose `hooks`, `onRequest` or `middlewares` deliberately answer or rewrite a request, and not an `init` that
  changes a nested value of its argument in place or an endpoint list changed after startup. App database hooks run first, so zero-stack's checks (invite-only) see the final data. A plugin that needs a refused `init` waits until an app asks.
  Gate: in every svelte permutation with auth the gate gives the app a plugin with an allowed `init` and one hook, and asserts the hook, the database hook and the trusted origin work over HTTP; the full permutation's existing
  checks (invite-only refusals, cancel-before-delete, the admin guard) run with it present. The `svelte-upgrade` honesty scenario also adds a trusted origin to the extension and expects no conflict.

## Flags

| Flag | Values | Notes |
|---|---|---|
| `--framework` | react (default without a terminal), vue, svelte (prompt default), solid | passthrough to create-void |
| `--tailwind` | bool | Tailwind v4 via `@tailwindcss/vite` (Void has no guidance) |
| `--shadcn` | bool | React only, implies `--tailwind` |
| `--zod-rpc` | bool | Void `defineHandler.withValidator` with a zod body schema + typed `void/client` call (no `@hono/zod-validator`: Void takes Standard Schema and feeds the client types) |
| `--auth` | bool | Void built-in Better Auth wiring, see below |
| `--account-deletion` | bool | Svelte only, implies `--auth`. Delete-account section on the Account page |
| `--email` | bool | Svelte only, implies `--auth`. Password reset and sign-up verification mail |
| `--turnstile` | bool | Svelte only, implies `--auth`. Cloudflare Turnstile on sign-up, sign-in and password reset |
| `--invite-only` | bool | Svelte only, implies `--email` and `--auth`. Sign-up limited to the `SIGNUP_ALLOWLIST` secret, with a verified email |
| `--admin` | bool | Svelte only, implies `--email` and `--auth`. Admin area at `/admin`, see below |
| `--payments` | bool | Svelte only, implies `--auth`. Stripe subscriptions through Better Auth's Stripe plugin (spec #81), see below |
| `--storage` | bool | Any framework, implies `--auth`. R2 per-user file routes and helper |
| `--secrets` | `infisical` (the only value) | Any framework, implies `--auth`. `secrets:pull` / `secrets:push` against Infisical `dev`, see below |

Starter is fixed to sqlite (D1). The add-ons are the wave 1 and 1b flags; each CLI flag has a
matching prompt. `--auth` on react, vue and solid is unchanged from v0.1.x (D34) except the shared rate limit: the
sign-in/sign-up pages, `void.config.ts` entry, alias, migration and `.env` below, plus a root
`auth.ts` that only sets `rateLimit: { storage: "database" }` (a shared limit across Worker instances, #58 D3, one D1 write per auth request; the migration gains the rate-limit table). On svelte, `--auth` also gains an Account page and a fuller composed `auth.ts`. No `--ui none`; no API-only mode exists upstream.

## Auth installer

Add `auth` to `void.config.ts`, a minimal sign-in/sign-up page for the chosen framework,
the `@auth-schema` tsconfig alias, run `void db generate` so the migration is in the generated tree, ready for the user's first commit (create-void `--git` only runs `git init`),
and write a gitignored root `.env` with a random `BETTER_AUTH_SECRET` and
`BETTER_AUTH_URL=http://localhost:5173` (mode 0600; plus the Turnstile test secret with `--turnstile` and `SIGNUP_ALLOWLIST=@example.com` with `--invite-only`). No `.env.example`: Void refuses
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
  lowercasing). `SIGNUP_ALLOWLIST` is a required (optional with `--admin`, see below)
  server secret (`string()` in the composed `env.ts`): exact emails and `@domain` entries
  separated by commas or whitespace, case-insensitive; `@x.com` matches exactly that domain
  (not `sub.x.com` or `evilx.com`); a missing or empty list refuses everyone (Void's required-env check turns an unset or empty value into a 500 on every request; a list with no entries refuses every sign-up). Matcher
  `src/signup-allowlist.ts` ships with `tests/signup-allowlist.test.ts`. Local `.env` gets
  `SIGNUP_ALLOWLIST=@example.com`. `env.ts` is composed from the enabled features
  (`src/installers/env-ts.ts`); no feature copies one. Going public means scaffolding or
  editing without the gate, never emptying the list.
- `--storage` (any framework): `src/storage.ts` (per-user keys `users/<id>/<name>` that reject
  escaping names, `purgeUserFiles`) and `tests/storage.test.ts`. With auth (always, via the
  implied flag) `routes/api/files/[name].ts` adds PUT (streamed, needs Content-Length, 413 over `MAX_BYTES` = 10 MB), GET
  and DELETE of the signed-in user's own files, each behind `requireAuth`. No route ships
  without auth. With `--account-deletion`, `auth.ts` purges the user's files in `beforeDelete`
  (fail closed: a storage error aborts the deletion, code `STORAGE_PURGE_FAILED`, shown by the
  page as partial-purge copy) and sweeps again in `afterDelete`.

- `--admin` (svelte): an admin area at `/admin` in the same app (spec #51; tickets #52: guard, Users,
  User detail, Audit log, #53: invites and onboarding, #54: feature switches, and #55: settings). An **admin** is a signed-in
  user with a verified email on the `ADMIN_EMAILS` secret (the invite-only matcher, `src/signup-allowlist.ts`, copied when
  `--invite-only` did not). It is optional with an empty default in the composed `env.ts` (unset or empty means no admins and
  `/admin` 404s while the app serves); the local `.env` gets `ADMIN_EMAILS=@example.com`. There is no promote button.
  - Every `/admin` page and `/api/admin/*` route is 404 for everyone else, signed out included: a global `middleware/10.admin.ts`
    gates the paths, and each loader and route also calls `requireAdmin`.
  - `auth.ts` gains Better Auth's `admin()` plugin (ban message "This account has been blocked. Contact the site owner.") and
    an `admin-guard` plugin (`src/admin-guard.ts`): on `/admin/*` it 404s unless the path is on an allowlist (`list-users`,
    `get-user`, `ban-user`, `unban-user`, `revoke-user-session`, `revoke-user-sessions`, `remove-user`;
    `set-role`, `create-user`, `update-user`, `set-user-password`, `impersonate-user`, `stop-impersonating`, `has-permission`,
    `list-user-sessions` (it returns raw session tokens; pages read sessions server-side and revoke by id through
    `POST /api/admin/users/:id/sessions/:sessionId/revoke`) and any future endpoint are refused) and the session user passes `isAdmin` right now; it is the only writer of
    `user.role`, so a listed user who verifies after signing in, or an address added to the list, is admitted on the same
    session, and a de-listed admin is refused at once. Void 1.8 does not cache sessions (probe P7), so the guard reads the
    session fresh; `adminClient` works through `void/client/svelte` (P6). See `docs/facts.md`.
  - **Audit.** `db/schema/admin.ts` (re-exported from `db/schema.ts`) holds `audit_entry`, whose user ids are `set null`
    (history outlives the user; the one exception to the cascade rule). The guard's after-hook writes one entry for every
    successful ban, unban, session revoke and delete (a repeat ban or unban included; the old value is the effective state, and a ban with `banExpiresIn` is refused 400), server-side; a failed write answers 500 `AUDIT_WRITE_FAILED` (the
    change stands; the page shows "Warning: this change was not recorded in the audit log."). `src/admin.ts` owns the row
    shape (`auditRow`). Viewing is never recorded.
  - **Delete** (U1, O1, E8, E16). With `--storage` the guard purges the user's files in its before-hook, after the admin and
    not-self checks, and refuses the delete (500 `STORAGE_PURGE_FAILED`, user intact) if the purge fails; self-delete keeps
    its `beforeDelete` purge. A shared `databaseHooks.user.delete.after` sweeps the files again and clears the deleted
    user's email (and ban-reason text) from the audit log; the delete's own entry has no target id, email or free text. The
    purge is composed when `(--account-deletion || --admin) && --storage`. The upload route deletes the object when the user
    row is gone after the `put`.
  - **Pages** (`pages/admin/`, one `admin.css`, no framework): Users (search by email or name through one read-only
    `void/db` query, the U2 departure; 50 a page, newest first, "Showing 51–100 of 128"), User detail (status line from
    `userStatus`, the fixing action, sessions with "This device", ban with an optional admin-only reason, delete with a typed
    email, "View audit log"), Audit log (`?user=` filter). The Account page gets an Admin link for admins and, for a listed
    but unverified user, "Your email is on the admin list but isn't verified yet." with a verification link. Success copy says
    "requested", never "sent". Every form uses `runAction` (`src/lib/admin-action.ts`: pending, done, done-unaudited, error).
  - **Send link**: `POST /api/admin/users/:id/send-link` calls `requestPasswordReset` on the server (no Turnstile token
    needed) and audits it, and refuses a missing or foreign `Origin` with 403; with `--invite-only` an unverified user's link is mailed as "Set your password".
  - **Invites** (`--admin --invite-only`, #53; U4, E10). Invites live in the database: `db/schema/invites.ts` (`invite`: an exact
    email or `@domain`, lower case, unique; who added it, `set null`; when; when its email was last requested) and `src/invites.ts`.
    `inviteAllowed(email, SIGNUP_ALLOWLIST)` is the env list OR the rows for the address or its `@domain`, through the same matcher
    (`signupAllowed`), and the composer swaps all three call sites in `auth.ts` (the user-create hook and both plugin re-checks) to it;
    `void/db` is imported on use. `SIGNUP_ALLOWLIST` becomes `string().default("")` in the composed `env.ts`: empty plus no database
    invite refuses every sign-up, so the app fails closed. It stays required for `--invite-only` alone. The Invites page (`pages/admin/invites.svelte`,
    nav entry after Users) adds an exact email or a whole domain with inline validation and the "Anyone at @x.com can sign up" preview, lists
    "Added here" with Revoke and, for exact emails, Send invite, and the secret's entries read-only. Routes: `POST /api/admin/invites`,
    `POST /api/admin/invites/:id/revoke` and `/send` (admin, same-origin). Add and revoke write the change and their audit entry in one `db.batch`;
    send mails the sign-up link (`send()`, subject "Your invitation to <host>", body naming the host and saying to sign up with that email) and then writes `last_sent_at` and its audit entry in one batch. One entry per change that happened (spec #51, PR #67 review): the audit insert in the batch selects from the invite row, so a revoke or send that lost a race writes nothing and
    answers 404; a concurrent duplicate add hits UNIQUE(entry) and answers 409; a resend within 60 seconds of `last_sent_at` is 429 "An invite was just sent. Try again in a minute." Copy: "Invited x@y.com." /
    "Invited anyone at @x.com." / "Invite removed." / "Invite email requested for x@y.com."; a revoke also says "Still invited through SIGNUP_ALLOWLIST."
    when the secret covers the entry and "Still invited through @x.com." when a remaining domain invite admits the address, and always "Existing accounts are not affected. Ban the user to block them." (an existing account is never touched).
    A Users search with no account in an invite-only app adds "x@y.com is not invited. Invite them" (opening Invites with the email filled in) or "Invited, but hasn't signed up
    yet."; an unverified user's status line says "Not invited (removed from the list)" when no source covers them. Generated tests: `tests/invites.test.ts`
    (`inviteAllowed`: env hit, database exact, database domain, lookalike refused, miss; entry parsing; the D6 copy) `tests/invites-db.test.ts` (the real queries on in-memory SQLite: concurrent revokes and adds, a send racing a revoke, the 60-second resend, the domain note) and `tests/invites-pages.test.ts`.
  - **Onboarding** (`--admin`, #53; E14, D20). `STEPS` is declared in `src/app/onboarding.ts` (the scaffold ships `example-step`; a data-only declaration file) and re-exported from `src/onboarding.ts`, which also has `markStep(userId, step)` (first time only;
    an undeclared name throws) and `progressFor(users)` (from rows the page already has); `onboarding_step` (user id `cascade`, step, reached at; primary key user and step). "Signed up" and
    "Email verified" come from the user row and are never stored. The Users list shows "n of m" in an Onboarding column and user detail the steps; both are
    hidden when `STEPS` is empty. Test: `tests/onboarding.test.ts`.
  - **Feature switches** (`--admin`, #54; D15, E3, story 75-80). `src/access.ts` exports exactly `FEATURES` (the scaffold ships `example-feature`), `Feature`,
    `features(c)`, `requireFeature(c, f)`, `adminSwitches(c, userId?)` and `decide(f, snapshot)`. Precedence, in one pure `decide()`: kill switch > per-user override
    (both directions) > plan > global > off; the pages get the result and its reason ("On: user override", "Off: kill switch applies to everyone") from
    `adminSwitches(c, userId).effective(f)`, built on the same rule. One snapshot per request, memoised on the raw request; an empty `sources` list for the plan layer
    (`--payments` appends to it); undeclared rows, unknown states and undeclared overrides are dropped. `requireFeature` is 401 signed out, 403 when off and 500 when
    the database fails; `features(c)` never throws (signed out or an error: the empty set, logged). `feature_switch` (feature, state) and `feature_override` (user id
    `cascade`, feature, state) live in `db/schema/admin.ts`; `set()` is bound to the admin who called `adminSwitches` and writes the change and its audit entry
    (`set-feature`, `set-override`, old and new value) in one `db.batch`. Routes: `POST /api/admin/features/:feature` (`{ state: on | off | kill }`) and
    `POST /api/admin/users/:id/features/:feature` (`{ state: default | on | off }`), admin and same-origin. The Features page (nav: Users, Invites, Features, Audit
    log) is a `<fieldset>` radio group per feature with its own Save; user detail has a select per feature and the effective result. Copy: "Saved. Applies on the
    user's next page load." and "Nothing declared yet. Add features in `src/access.ts`." `routes/api/example-feature.ts` is the gated example the gate drives.
    Tests: `tests/access.test.ts` (exports, precedence table over every combination, fail-closed) and `tests/access-pages.test.ts`.
  - **Settings** (`--admin`, #55; D16, E3, story 81-82, 54-56, 73). `src/settings.ts` exports exactly `SETTINGS`, `setting(key)` and `adminSettings(c)`; `SETTINGS` is declared in the app-owned declaration file `src/app/settings.ts` (data only, types imported
    from `src/lib/setting-value.ts`) and re-exported. A setting is declared in
    `SETTINGS` as a key, a `type` (`text`, `number` with optional `min` and `max`, `boolean`, `choice` with `values`), a `default` and a `description` (the scaffold ships four
    examples and `routes/api/example-settings.ts` that reads them). `await setting("key")` is typed from the declaration and returns the stored value, or the default when
    nothing is stored or the stored text no longer fits (wrong type, out of range, not in the set: the Settings page says "Stored value is invalid; using the default.");
    a database failure throws. The pure parse and validate (`src/lib/setting-value.ts`: text up to 1000 characters, number with inclusive bounds, boolean, choice, undeclared key
    refused) is shared by the getter, the admin saves and the page's display. `setting` (key primary, value as text, updated at) lives in `db/schema/admin.ts`; rows for
    undeclared keys are ignored. `adminSettings(c)` is admin only and bound to the admin: `set(key, value)` parses against the declaration (400 with the message, 400 for an
    undeclared key) and upserts the row with its audit entry (`set-setting`, old value then new) in one `db.batch`; `reset(key)` deletes the row with its audit entry
    (`reset-setting`, old value then the default) in one `db.batch` whose audit insert only runs while the row it describes still exists, so a reset that finds no row or loses a race
    to another request writes nothing and answers 404. Routes: `POST /api/admin/settings/:key` (`{ value }`) and `DELETE /api/admin/settings/:key`, admin and same-origin. The
    Settings page (nav: Users, Invites, Features, Settings, Audit log) is one form per setting with its label, description, "Default: X" and its own Save: a checkbox plus Save for
    on/off (never save-on-tap), `type="number"` with `min` and `max`, a `<select>` for a choice, and "Reset to default" once a stored value differs; the form is `novalidate`, so the
    server's message ("Enter a number from 1 to 100.") is the inline error. Copy: "Saved. Applies on the user's next page load." and "Nothing declared yet. Add settings in
    `src/app/settings.ts`." An undeclared key answers "That setting is not declared in src/app/settings.ts." A setting is never a secret (AGENTS.md says so). Tests: `tests/settings.test.ts` (exports, defaults valid, text, number bounds, boolean, choice, undeclared
    key, stale value; it mocks `src/app/settings.ts` with its own setting, so it passes whatever the app declares), `tests/settings-pages.test.ts` and the scaffold-owned
    `tests/declarations.test.ts`, which checks every declaration file the app has in `src/app/`: no runtime imports (only `import type`), each setting declared once with a default
    that fits its type, onboarding steps unique and non-empty, each failure naming its reason; it also feeds itself bad examples so a check that stops working fails.
  - `session.create.before` writes `lastSignInAt` (a `user.additionalFields` column) and nothing else.
  - The CLI closes with "To use /admin, sign in with an email on ADMIN_EMAILS and verify it."; `AGENTS.md` gets an Admin
    section. Generated tests: `tests/admin*.test.ts` (matcher, `userStatus`, the guard over a real Better Auth, the action
    helper, D14 page checks) and, with `--storage`, `tests/upload-guard.test.ts`.

- `--payments` (svelte, spec #81; #82 is subscriptions, #84 is deletion; one-off purchases and the admin view are #83 and #85): `@better-auth/stripe`,
  `stripe` and `better-auth` pinned in `PAYMENTS_DEPS` (one better-auth copy, gate-asserted). `src/plans.ts` declares plans by Stripe price lookup
  key (monthly price, optional trial days); `src/stripe.ts` builds the client and refuses `STRIPE_API_URL` off localhost;
  `src/billing.ts` holds `requirePlan` / `currentPlan` (active, trialing or past_due; read from the app's copy, never Stripe), `billingPlugins(env)`
  (the plugin plus the guard, spread into `auth.ts`), `billingGuard` (on upgrade, billing-portal, cancel and restore: 503 `STRIPE_NOT_CONFIGURED`
  while `.env` has the placeholder key, 400 `SUBSCRIPTION_NEEDS_CARD` on upgrade while a past_due or unpaid row exists; the webhook answers 400
  `STRIPE_WEBHOOK_NOT_CONFIGURED` while the secret is the placeholder) and `syncStripeEvent`, the plugin's `onEvent`: for a subscription event on
  a declared price whose customer a user holds, `created` throws (a retried 400) when the row is missing (only for an event under an hour old; an older one is logged and answers 200), and `updated` / `deleted` read the live
  subscription from Stripe and write its plan (from the lookup key of the live item that is a declared plan, wherever it sits in the list), status, cancel-at-period-end, cancel-at and period when the row
  differs (so an older event retried late can't win), only to a row whose `referenceId` is that user; a failed read or write throws. No such
  user or a subscription Stripe no longer has (`resource_missing`) answers 200. An `updated` or `deleted` event that carries no declared
  price is still synced when that user already has a row for the subscription (it was moved to an undeclared price in the dashboard); one
  with no row is ignored. A live subscription with no declared plan keeps the row's plan and still gets the live status, cancel fields and
  period, so a canceled one can't stay active. `auth.ts` exempts
  `/stripe/webhook` from rate limiting. The Billing page `/billing` (linked from the Account page) reads the subscription table directly and
  shows none, active, trialing, cancelling with its end date, past_due and unpaid (portal button, no Subscribe), canceled. `scripts/stripe-seed.ts`
  (`bun run stripe:seed`) creates the declared prices by lookup key, skips existing ones and refuses live keys. `env.ts` declares
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (required; `.env` ships `sk_test_placeholder` and `whsec_placeholder`) and optional
  `STRIPE_API_URL`. Setup: a sandbox agent step, and human steps for live Stripe plus its key and the live webhook endpoint plus its secret.
  Gate: a fake Stripe over HTTP and webhooks signed with Web Crypto HMAC; generated test `tests/billing.test.ts`.
  - **Deleting a user** (#84). `cancelSubscriptions(env, userId)` in `src/billing.ts` runs first on both paths, ahead of the storage purge:
    in `deleteUser.beforeDelete` (`--account-deletion`) and, as the guard's `cancelBilling` option, in the admin guard's remove-user before-hook
    (`--admin`, after the admin and not-self checks). Better Auth's database delete hooks run after the purge, so the cancel is not there. It reads
    the user's `stripeCustomerId` (none: nothing to do, no Stripe call), expires the customer's open Checkout sessions (one paid after the
    deletion would start a subscription nobody owns), then lists that customer's subscriptions in Stripe (any status, not the table, so a
    past_due one or one whose webhook hasn't arrived ends too) and cancels each that is not `canceled` or `incomplete_expired`. Sessions go
    first, so a Checkout completed meanwhile is caught: its expire fails (retry), or its subscription is already in the list. A customer Stripe
    doesn't have (`resource_missing` on `customer`: sandbox ids after a move to live keys, or deleted in Stripe) leaves nothing to cancel, and
    the deletion goes ahead. That is "this key's Stripe account has no such customer", not proof nothing is billing: a key swapped to a
    different live account leaves the old account's subscriptions running. When only the cancel fails, the sessions are already expired.
    Fail closed: any error (the database, Stripe unreachable, a refused cancel or expire) stops the deletion with 500 `BILLING_CANCEL_FAILED` and the
    message "Couldn't cancel the subscription in Stripe, so the account was not deleted. Try again.", which the Account page and the admin
    user page show as it is; the user, their rows and their files are intact (subscriptions cancelled before the failing one stay cancelled,
    and a retry skips them). After the delete, the one `databaseHooks.user.delete.after` (composed for `--admin`, or `--payments` with
    `--account-deletion`) calls `deleteSubscriptionRows(userId)`: the plugin's rows have no foreign key; a failure there is logged, not thrown.
    The cancel comes before the delete, so if the delete itself then fails the user remains with their subscriptions cancelled (the safe
    direction, as with the purge). Stripe's `customer.subscription.deleted` for the cancellation then finds no user and answers 200. No `payment` table exists yet (#83).
  - **With `--admin`** (#85). One anchored edit fills the empty `sources` slot of `src/access.ts`: `PLAN_FEATURES` (feature to plan names, lowercase; the
    scaffold ships `example-feature` for `pro`) and `featuresForPlan(plan)`, fed by `currentPlan`. Precedence is unchanged (kill switch, per-user override, plan,
    global). The Features page says "Also on for users on the pro plan" for such a feature, and the user page shows why ("On: included in the user's plan").
    The admin user page gets a read-only Billing section: plan, status, renewal or end date (the Billing page's `billingView`), and a link to the customer in
    the Stripe dashboard, test mode unless the key starts `sk_live_` or `rk_live_` (derived on the server; the key never reaches the page); "No subscription." and
    "No Stripe customer yet" when there is none. No refund or plan-change buttons and no audit rows for plan changes (they happen in Stripe). Without `--payments`
    none of this exists. Test: `tests/plan-features.test.ts`; the gate covers the plan-only feature (off without the plan, on with it, off under the kill
    switch, on for a comped user) and the Billing section.

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
- `--admin`: set `ADMIN_EMAILS` for prod (`void secret put ADMIN_EMAILS`, or Infisical `prod` through the production route); dev uses the
  `@example.com` placeholder. Unset or empty: no admins, `/admin` is a 404. The first admin signs in with a listed address and verifies it. With
  `--admin --invite-only`, `SIGNUP_ALLOWLIST` is optional: invites can live in the database only.
- Always: `BETTER_AUTH_SECRET` (`void deploy` creates it). Nothing needs `BETTER_AUTH_URL` in production: Void sets the auth base URL and trusted origin from the request origin.

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
`db:reset` (`void db reset --yes`), `doctor` (`bash scripts/doctor.sh`, see Setup guide). Ships one `vi.mock`-based route test (Void tests run
in Node; bindings are unavailable). `AGENTS.md` tells agents to run `verify` before
finishing. No wrangler files, ever (Void migrates a root `wrangler.jsonc` itself).

## Setup guide

`src/setup.ts` holds one typed step list (`STEPS`): title, why, who (`agent`, `agent-browser`, `human`), action, a verify
command (exit 0 = done) and the env names the step covers. A step has a flag predicate, so a step that does not apply is never
shown. Three composers read it: the `## Setup` table in `AGENTS.md`, `docs/setup.md`, and `scripts/setup-wizard.sh` (one stage per
`human` step; a done step is detected by its verify command and skipped; typed values are read hidden, never printed, and go to
`void secret put` by stdin, plus Infisical `prod` by stdin (`--file /dev/stdin` fed `NAME=value`, never a file on disk) with `--secrets`; `void` is found through `node_modules/.bin`; a failed put is reported, not fatal). The wizard never opens a browser: it prints links. A unit test fails when a flag adds an env name in `authEnv`
or `env.ts` that no step covers. A fourth composer writes `scripts/doctor.sh` (`bun run doctor`, every framework): rows are `void env check`, local
migrations (`void db status`, fail closed on unrecognised output), each step's verify with the guide's number and title (`<app-host>` and `<app-name>`
become `APP_HOST`, which must be set or the Deploy row FAILs, and `APP_NAME`, default the scaffolded name), then `void env check --remote`. Each prints PASS, FAIL
(one fix line) or NOT CHECKED (every row after a failed sign-in step, the steps with an interactive `exec`); output is discarded, stdin closed,
a time limit applies; exit 0 only when every row passed. The gate runs it under an isolated HOME and asserts each row. The gate checks the steps against the flags and runs `bash -n` on the wizard. Commands are the pinned Void's, `cf` and `infisical` only, never wrangler; Void-side browser driving stays in the agent's harness, not in the app.

## Routing docs

One source, `docs/cloudflare-routing.md`: need -> product -> Void module or `cloudflare:`
pass-through -> docs URL, with a status column (`verified` / `unverified — read docs
first`) and the Void version it was checked against (in its header). Hand-regenerated on pin
bump; `bun scripts/bump-void.ts` lists docs checked against an older Void. Preamble rules: check `node_modules/void/docs/` and the table before raw Wrangler
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
  `svelte-turnstile`, `svelte-invite-only`, `svelte-admin`, `svelte-admin-storage`, `svelte-admin-invite-only`, `svelte-payments` (with `--account-deletion`), `svelte-payments-admin`, `storage`, `svelte-storage-deletion`, `tailwind`, `zod-rpc`.
- Gate checks per flag (`scripts/gate.ts`, HTTP against `vp dev`): `--auth` sign-up, sign-in,
  session, `/settings` signed in and out, wrong then right change-password, other session
  revoked, migration present, `.env` gitignored; `--email` reset mail in the dev inbox, link,
  new password signs in, bad or used token rejected, earlier sessions revoked;
  `--turnstile` sign-up, sign-in (and reset) refused without a token, accepted with the dummy
  token; `--invite-only` @example.com admitted (any case) with no session and no kept password
  until the dev-inbox set-password link is followed; in both orders (attacker first, owner
  first) a raw-API attacker's password P is refused, each address gets one set-password
  mail while its link is live (wrong-password, cross-origin and no-name requests add none),
  the owner sets Q through a link, then P gets 401 and Q 200, no verify link is ever
  mailed, a later sign-up over the verified user changes nothing; a pending user removed
  from the list gets no mail and their old link neither verifies nor resets, while a
  verified user removed from the list still resets and signs in; lookalike domain
  and subdomain leave no user row and no mail, an exact entry admits and a
  same-domain address is refused, an empty list refuses everyone, existing users still sign
  in (the list is changed by restarting the dev server on a new `.env`); `--admin` 404 for signed out, a non-admin, a listed but
  unverified user, case and encoding variants of `/admin`, and the 7 refused endpoints (even for an admin), 200 for an admin; a listed user who verifies after
  signing in, and a newly listed one, reach `list-users` on their existing session, a de-listed live session is 404 on pages and API, and an empty
  `ADMIN_EMAILS` is 404 while `GET /` is 200; search by email (any case) and by name, the no-match copy, `%` not a wildcard, paging; ban ends sessions and sign-in
  shows the blocked copy, unban restores it; revoke one then all sessions; send-link lands in the dev inbox and sets a password (with no Turnstile token, and as a
  set-password link for an unverified invite-only user); self-ban and self-delete 400; delete removes the row, sessions and files and leaves no audit entry
  holding the deleted email; the audit page newest first and `?user=`; onboarding "n of m" in the list and the steps on user detail, and onboarding rows gone with the user; feature switches: nothing set is off (401 signed out, 403 signed in), global on and off, an override in both directions, the kill switch beats an override on, the pages show the effective result and reason, an undeclared row is dropped, refused changes write no audit entry and every change is audited; settings: the getters return the declared defaults, a save of each type is read back and audited with the old and new value, an out-of-range number, a wrong type, a value outside the set, an undeclared key, a non-admin and a missing or foreign Origin are refused with no audit entry, reset restores the default with one entry, a reset at the default and the loser of two concurrent resets write nothing, an invalid stored value reads as the default and is flagged, an undeclared row is dropped; `--admin --invite-only` with no `SIGNUP_ALLOWLIST`: a database invite (exact and domain) admits at once with no restart, a lookalike and no source are refused, revoke refuses again and leaves the existing account, the reset-password re-check reads the database, send-invite lands in the dev inbox, every change is audited, a search with no account says not invited or invited, and with a secret the secret still admits, shows read-only and a revoke of a covered entry says "Still invited through SIGNUP_ALLOWLIST."; `--account-deletion` missing/empty password 400, wrong password rejected, right password deletes; `--storage` 401
  without a session, upload and download under `users/<id>/`, escaping names rejected, exactly 10 MB stored and 10 MB + 1 byte refused 413 with nothing stored (keys
  read back from the local R2 state), object gone after account deletion; `--payments` with `--account-deletion` and with `--admin`: while the fake Stripe is down (every call, or only the cancel) the deletion answers 500 `BILLING_CANCEL_FAILED` with the user, their subscription rows and (with `--storage`) their files intact, then it cancels the past_due and active subscriptions (ended ones are left alone) and expires the open Checkout session in the fake Stripe, the user, files and subscription rows go, and a late `customer.subscription.deleted` answers 200. The
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
