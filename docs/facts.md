# Verified facts (create-void@1.8.0, bun 1.3.14, node 26.13.1, 2026-11-12)

## Bun script trust for workerd / esbuild

`bunx create-void@1.8.0 probe --toolchain vite-plus --framework react --starter sqlite --deploy none --git`
then `bun pm untrusted` in the app: `Found 0 untrusted dependencies with scripts.`
`node_modules/workerd/bin/workerd --version` runs (`workerd 2026-11-10`). So nothing needs
approval today (workerd ships its binary through the platform optional dep). We still write
`trustedDependencies: ["esbuild","workerd","sharp"]` (SPEC step 7) as cheap insurance; the
scaffold gate (`bun run ci`) proves build and dev work with it.

## `vp install` with `bun.lock`

In the scaffolded app, `env -u npm_config_user_agent node_modules/.bin/vp install` runs
`bun install` ("Checked 257 installs across 471 packages (no changes)"), keeps the single
`bun.lock`, and creates no other lockfile. vp picks bun from the existing lockfile even
without a user agent.

## Bun user agent

`bunx -p typescript sh -c 'echo UA=$npm_config_user_agent'` prints
`UA=bun/1.3.14 npm/? node/v24.3.0 darwin arm64`. Running create-void via `bun x` therefore
sets the bun user agent, and create-void installs with bun (`bun install v1.3.14` in its
output; `bun.lock` produced). `bun create` itself was not tested; the CLI always uses `bun x`.

## Surprise: raw create-void output fails `vp check`

Untouched `create-void@1.8.0` output (React/sqlite) fails `vp check` with "Formatting
issues found in 11 files" (AGENTS.md, package.json, pages/*, db/*, configs...).
`vp check --fix` fixes all of them and lint is clean. The pipeline therefore runs
`vp check --fix` once after the install. Re-verify on every pin bump.

## Dev server

`vp dev` listens on `localhost` (check with `http://localhost:<port>/`, not 127.0.0.1).
It prints a Cloudflare agent banner and an inspector-port notice; harmless.

## `@cloudflare/vite-plugin@2.0.0-rc.0` breaks `vp build` (2026-11-16)

void@1.8.0 depends on `@cloudflare/vite-plugin@^2.0.0-beta.v.15`, which now resolves to `2.0.0-rc.0`.
It writes `.cloudflare/output/v1/` while void's `@cloudflare/build-output-utils@^0.9.13` reads
`v0/config.json`, so every fresh scaffold fails `vp build` with "no root config found". Reproduced on a
plain react scaffold; `overrides: {"@cloudflare/vite-plugin": "2.0.0-beta.v.17"}` plus `bun install`
builds again. The generated package.json carries that override (`OVERRIDES` in `src/versions.ts`);
drop it when the void pin moves to a release that matches rc.0. **Dropped with create-void 1.11.0** (2026-11-23): void now pins rc.0 and `build-output-utils@1.0.0-rc.0`, and ci:full builds every framework without it.

## `vite-plus@1.7.0` breaks `vp build` (2026-11-17)

create-void@1.8.0 writes `"vite-plus": "^1.6.0"` and `"vite": "npm:@voidzero-dev/vite-plus-core@^1.6.0"`
(also as an override). `vite-plus@1.7.0` requires core `8.3.8000` (new version scheme), which `^1.6.0`
can't resolve, so `vp build` fails with "Expected @voidzero-dev/vite-plus-core@8.3.8000, but found 1.6.0".
Reproduced on a plain react scaffold; adding `"vite-plus": "1.6.0"` to `overrides` and reinstalling builds
again. Carried in `OVERRIDES` (`src/versions.ts`); drop it with the next void pin (see #16). **Dropped with create-void 1.11.0** (2026-11-23).

## Local D1 enforces foreign keys and `onDelete: "cascade"` (2026-11-18)

Scaffolded `--framework svelte --account-deletion`, added `note(id, user_id NOT NULL REFERENCES user(id) ON DELETE cascade)`
(`void db generate` emitted `FOREIGN KEY ... ON DELETE cascade`), `void db reset`, `vp dev`. Signed up, inserted one `note`
for the user through a route, then `POST /api/auth/delete-user` with the password: `{"success":true,"message":"User deleted"}`,
and the `note` count went 1 -> 0. Better Auth deletes only its own tables (session, account), so the child row went because
the database cascaded. Deployed D1 is the same engine; the AGENTS.md cascade rule for user-owned tables (account-deletion)
rests on this. App tables are not created by `vp dev` alone: they need `void db generate` and `void db reset`/migrate.
Importing `@auth-schema` from `db/schema.ts` failed at dev start ("Cannot find module '@auth-schema'"); the probe used
`../.void/better-auth-schema`. Docs show `@auth-schema`; unresolved here, so check it before telling users to use it.

## `--payments`: Stripe CLI key and Checkout (2026-11-24, #82)

**Not checked: the repo's Stripe CLI profile does not exist yet.** `STRIPE_PROJECT_NAME=create-void-app-scaffold` (set by the
SessionStart hook), and `stripe get /v1/account` answered "no config for that project was found. Please run `stripe login
--project-name ...`". Per the machine's Stripe rules the agent did not log in. So whether the profile's restricted key (`rk_test_`)
can create a Checkout session in the sandbox is still open: after `! stripe login --project-name create-void-app-scaffold`, run
`stripe get /v1/account` (print only `id`), then create a throwaway price and a `mode=subscription` Checkout session with it,
expire the session and archive the price and product. A restricted key without Checkout write needs a full `sk_test_` key in
`.env` instead (the seed script and the app accept both).

What a restricted key (`rk_test_`, or a live `rk_live_`) needs, from the calls the app and the plugin make (read from the plugin's 1.7.28
source and `src/billing.ts`, not yet tried against Stripe): read on subscriptions (the sync after every update or deletion, and upgrade's
list), customers and prices; write on Checkout sessions and Customer portal sessions; write on customers (the first checkout creates one,
and the plugin updates its email); and, for `bun run stripe:seed` only, write on prices and products.

## `--payments`: @better-auth/stripe 1.7.28 under Void 1.11.0 (2026-11-24, #82)

- `bun add @better-auth/stripe@1.7.28 stripe@23.2.0` in a fresh scaffold keeps one `better-auth` (1.7.28, the version void's
  `^1.7.25` resolves); the app pins `better-auth` to the same version so a later release can't add a second copy.
- `void db generate` with the plugin adds the `subscription` table and `user.stripeCustomerId`; the generated schema exports
  `subscriptionTable` from `.void/better-auth-schema.ts`.
- `new Stripe("")` throws ("Neither apiKey nor config.authenticator provided"); Void evaluates `auth.ts` at build time with no
  server env, so `src/stripe.ts` falls back to the placeholder key.
- The plugin's `onEvent` gets only the event (no context), and a throw from it becomes 400 `STRIPE_WEBHOOK_ERROR`, which Stripe
  retries. Its subscription handlers catch their own errors, so `syncStripeEvent` reads and writes through `void/db` (and reads the live subscription from Stripe).
- Void turns Better Auth rate limiting on only for deployed Cloudflare requests (a `cf` object and a non-loopback
  `cf-connecting-ip`), so the webhook exemption (`customRules: { "/stripe/webhook": false }`) can't be exercised under `vp dev`;
  the gate checks `auth.ts` for it.

## `--admin` probes P6 and P7 (2026-11-22)

Scaffolded `--framework svelte --email` (void@1.8.0, better-auth@1.7.27), added `admin()` to `auth.ts`, `void db generate`
(adds `user.role`, `banned`, `banReason`, `banExpires` and `session.impersonatedBy`), ran `vp dev`.

- **P6, `adminClient` through `createAuthClient` from `void/client/svelte`: works.** `void/client/svelte` re-exports
  `createAuthClient` from `better-auth/svelte` unchanged. `tsc --noEmit` accepts
  `createAuthClient({ basePath, plugins: [adminClient()] })` with typed `c.admin.listUsers`, `c.admin.banUser` and
  `users[0].role` (a deliberate type error in the same file is caught, so the file was checked). At runtime the client
  called `/api/auth/admin/list-users` with a signed-in session cookie and got the user list. `better-auth` resolves
  from the app root without being in `package.json` (a transitive of `void`; the generated `auth.ts` already imports it).
- **P7, Void 1.8 does not cookie-cache the session: confirmed.** Sign-in sets only `better-auth.session_token`
  (no `session_data` cookie); `void/dist` has no `cookieCache` and its auth defaults carry no `session` key. Runtime proof:
  set `user.role='admin'`, `list-users` 200; set `role='user'` in the database and replay the same cookie: `list-users`
  403 `YOU_ARE_NOT_ALLOWED_TO_LIST_USERS` at once, and `get-session` shows the new role. So the admin guard needs no
  cache-disable option; if a Void bump adds a cache, the gate's de-listed and ban checks fail first.

## Doctor probes (void@1.11.0, real CLI, isolated HOME, scaffolds `--framework svelte --auth --admin` and bare, 2026-11-24)

- `void env check`: exit 0 and "Local .env values are valid." when `.env` satisfies `env.ts`; exit 1 and "Missing required env vars: NAME" when not (a key with `.default()` is optional, so deleting `ADMIN_EMAILS` from `.env` still passes). A bare app has no `env.ts`: exit 0, "No env.ts found". Any stray `.env.bak` makes it exit 1 ("only .env is supported").
- `void db status` exits 0 whatever the state. Before the first `db:reset`: "N migrations, N pending locally". After: lines `local: applied` and a bare "N migration(s)" with no "pending". A migration file missing from `meta/_journal.json` prints "Migration drift detected" (no "pending"), still exit 0. So the doctor passes only on exit 0, no "pending locally", and a line `^ *N migrations?$`; anything else fails closed. A real pending migration for the gate: append a table to `db/schema.ts`, `void db generate`.
- Signed out, new app (platform none): `void cloudflare status` exit 1 "Not signed in to Cloudflare"; `void secret list` and `void env check --remote` exit 1 "Deployment is disabled. Run `void init`..."; `void email status --platform cloudflare` exit 1 "no Cloudflare account is pinned".
- `void db migrate` is the local "apply pending migrations" command (fix line for the migrations row).
- The app ships `node_modules/.bin/cf` (a dependency of void), which `scripts/doctor.sh` and the wizard put ahead of any global `cf`. Signed out, `cf auth whoami` exits 0 with `"authenticated": false` (so the step verify greps for `true`) and its stderr tells an agent to run `cf deploy --temporary-account`; the doctor discards output, so that advice never reaches an agent.

## Upgrade seam probes (create-void@1.11.0, vite-plus via `vp`, bun 1.3.14, 2026-11-24)

- **`vp check` scans `.zero-stack/`.** A hand-written, unformatted `.zero-stack/base.json`, `manifest.json` and `t.ts` in a scaffolded app made `vp check` fail with "Formatting issues found" for all three. The same files written as `JSON.stringify(value, null, 2) + "\n"` (strings with quotes, `\n`, U+2028, backslashes, a 500-character line, an empty string, base64) pass: "All 94 files are correctly formatted". So the writer produces formatter-clean output and nothing needs to skip the folder; `tsc` (its `include` lists directories) and `vp test` (matches test files only) never read it.
- **The generated migration SQL is byte-identical between two scaffolds** of one version and flags (`--framework svelte --tailwind --zod-rpc --auth --account-deletion --email --turnstile --invite-only --admin --payments --storage --secrets infisical`, run twice): two `.sql` files each time, `cat db/migrations/*.sql | shasum` equal. What differs is the file names (`20261124214700_previous_stranger.sql` against `20261124214733_opposite_martin_li.sql`), the snapshot names and `meta/_journal.json` (`when`, `tag`), and `.env` (a random secret). So the manifest hashes the SQL only, in name order, and the base copy skips `db/migrations`.
- **A nested scaffold cannot be formatted while its folder is ignored.** With `.zero-stack/upgrade-tmp` in the parent app's `.gitignore`, `vp check --fix` (and `vp fmt`) inside the nested app exits with "Expected at least one target file. All matched files may have been excluded by ignore rules": oxfmt applies the parent's `.gitignore` to everything below it, and `--ignore-path` does not lift it. An empty `.git` folder in the nested app marks a repository boundary and the formatter then runs normally (49 files checked). `upgrade` creates that folder only around the `vp` step and removes it right after.

## R2 bucket name (void@1.11.0, read from `npm pack void@1.11.0`, 2026-11-24)

- `dist/deploy-2QjsBEGw.mjs` (`desired.r2`): the bucket is `suffixedResourceName(workerName, "storage")`, i.e. `<worker>-storage`, unless the generated wrangler config already stores a real `bucket_name`. `workerName` is `deriveWorkerName(root)`: package.json `name`, cleaned by `toValidWorkerName` (lowercase, max 63 chars; the scaffold's names are already `[a-z0-9-]`). Under `vp dev` the local bucket is `default` (`dist/index.mjs`).
- So the app's bucket is exactly `<app-name>-storage`, known before connect or deploy. The doctor's R2 row still requires step 2 (`.void/project.json` names cloudflare) and matches the whole name as a token (not touching `[a-z0-9-]` on either side), because `cf r2 buckets list`'s output format is not pinned here. A name over about 56 characters is trimmed by Void and would not match.

## Svelte email rendering (spike #111, 2026-11-25)

Probed in a scratch scaffold (`bun src/index.ts mail-app --framework svelte --auth --email`; void 1.11.0, svelte 5.59.1, vite-plus 1.7.0, bun 1.3.14) with a `.svelte` email (`Welcome.svelte`: nested `<table>`, inline styles, a `<style>` block with two class rules, props `name` and `url`), a route that calls `render` from `svelte/server` and `sendEmail` from `void/email`, and a plain template-string function for comparison. Run on `vp dev` (dev inbox) and on `vp build` + `vp preview` (the built Worker in workerd). No real account or provider was touched; the scratch app is deleted.

- **Svelte's own server render works inside the Worker, in dev and in the built bundle.** `import { render } from "svelte/server"` plus `import Welcome from "../../src/emails/Welcome.svelte"` from a route handler, `render(Welcome, { props })` returns `{ head, body }` (also `html`). No configuration, no new dependency (`svelte` is already a dependency of every svelte scaffold). Props are escaped: `name: "Ada <b>"` came out `Hello Ada &lt;b>`, and `&` in an attribute as `&amp;`.
- **The component's `<style>` block is dropped from the output.** Default render: `head` is `""` and the body carries no `<style>`; only class names remain. Dev: every element gets `class="svelte-1lr1ced"` (including ones the CSS never touches). Built: only elements a rule matches keep the hash (`<td class="hd svelte-1lr1ced">`, `<a class="btn svelte-1lr1ced">`). In both, the rules (`.hd { border-bottom }`, `.btn { border-radius }`) are gone, so class-based CSS silently loses its styling in the email. Inline `style="..."` attributes survive untouched. With `<svelte:options css="injected" />` on the component, `head` becomes `<style id="svelte-1jwdjjt">.hd.svelte-1jwdjjt {border-bottom:1px solid #ddd;}</style>` (same in the built Worker): a `<style>` in `head` that Gmail and Outlook strip or ignore for the hashed class selectors, so it still needs inlining. So the template check should reject a `<style>` block (and `class=` for styling) and require inline `style`.
- **Output noise:** the body is wrapped in hydration comments `<!--[-->` ... `<!--]-->` (harmless to clients, can be stripped with one replace); no `<html>`, `<head>` or doctype, so the layout must supply `<!doctype html><html><body>` around `body`.
- **Svelte rejects `<tr>` directly under `<table>`** at compile time (`node_invalid_placement`, `<tr> cannot be a child of <table>`): a table-layout email must write `<tbody>`, which is also valid and inert in email clients.
- **`sendEmail` takes `html`, `text` and `headers`** (`node_modules/void/docs/guide/email/sending.md`, Options): `html` plus `text` is sent as `multipart/alternative`; `headers` is `Record<string, string>` for custom headers (reserved ones such as From and Date are ignored). A probe with `headers: { "List-Unsubscribe": "<https://example.com/unsub?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }` returned `{ ok: true }`.
- **Dev inbox shows both parts and both headers.** `GET /__void/inbox/<id>/raw` (header `x-void-dev-trigger: <.void/dev-trigger-token>`) returned `List-Unsubscribe: <...>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `Content-Type: multipart/alternative`, a `text/plain` part and a `text/html` part, the HTML exactly as rendered. The detail page `/__void/inbox/<id>` lists both under "Custom headers" and shows the HTML in `<iframe sandbox srcdoc="...">`; it does not show the text part, so the gate reads `/raw` for that. Not looked at in a browser (agents never open one); the iframe's content was checked as text.
- **The built Worker in `vp preview` renders identically but cannot send:** `sendEmail` returned `INVALID_FROM` ("'from' is required...") because preview has no dev inbox and no platform-injected sender. Rendering is therefore proven in the built Worker, sending is proven in dev only (as the gate does today).
- **Bundle size** (sum of `dist/ssr/**/*.js` after `bun run build`, the scaffold alone against the scaffold with the Svelte email, a plain-function email, two probe routes and `sendEmail`): 2,814,272 B raw, 621,246 B gzip, 35 files, `index.js` 7,880 B; with the probes 2,817,941 B raw, 622,910 B gzip, 39 files, `index.js` 7,880 B. The delta (+3.7 KB raw, +1.7 KB gzip) is the routes and the compiled component: Svelte's server runtime is already in the Worker because the pages render server-side, so email rendering adds no Svelte code. Cold start was not measured (no deploy; workerd locally is not a fair proxy).
- **Build-time rendering works without Vite:** `compile(source, { generate: "server", css })` from `svelte/compiler` writes a module that `render` runs under plain `bun` in 0.17 s, `css: "external"` gives the same dropped styles, `css: "injected"` the `<style>` in `head`. A script could write the HTML of each template to a generated file, so the Worker would carry no render call; cost: a build step the app must run before `vp dev` and `vp build` (a Vite plugin or watch script to keep it fresh while editing), a generated artifact for props (props are only known at send time, so a build-time render yields a string template with placeholders, not a rendered mail), and `lang="ts"` needs stripping or `svelte/compiler`'s preprocess. For per-recipient data (name, unsubscribe URL, confirm link) this is worse than rendering in the Worker, which already costs nothing.
- **Plain text from HTML:** a probe of eight chained regex replaces (drop `<style>`, turn `<a href>` into `text (href)`, close tags into newlines, strip tags, `&amp;` back, collapse blank lines) gave `Hello Ada &lt;b>\nOpen (https://example.com/go?a=1&b=2)`: readable for a one-heading, one-button mail, but it leaves entities (`&lt;`) and flattens tables and lists, so a real mail needs an entity decoder or a hand-written text part. Writing the text alongside (a second small component or a template literal next to the HTML) is exact and costs a few lines per template.
- **Smallest email-safe output without a library:** inline `style` attributes written by hand in the Svelte component, `<tbody>` tables, a layout component that wraps `body` in the document skeleton. The same mail as a plain function with a template literal is shorter to write (the probe's table mail is 2 lines against 20 for the component) and has no compile quirks, but gets no escaping (an `${name}` with `<` goes through raw unless the author calls an escape helper) and no preview-by-component; Svelte escapes every prop and interpolation automatically, which matters for names typed by a stranger. A style-inlining step (juice and similar) would be a new dependency or a hand-written parser; a third-party renderer (React Email, MJML, Maizzle) would add its own runtime and toolchain, and the charter rules one out for now.

Email templates are Svelte components, rendered with `svelte/server` in the Worker, with inline styles and no `<style>` block.
