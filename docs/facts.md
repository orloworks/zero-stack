# Verified facts (create-void@1.8.0, bun 1.3.14, node 26.13.1, 2026-11-12)

## Bun script trust for workerd / esbuild

`bunx create-void@1.8.0 probe --toolchain vite-plus --framework react --starter sqlite --deploy none --git`
then `bun pm untrusted` in the app: `Found 0 untrusted dependencies with scripts.`
`node_modules/workerd/bin/workerd --version` runs (`workerd 2026-11-10`). So nothing needs
approval today (workerd ships its binary through the platform optional dep). We still write
`trustedDependencies: ["esbuild","workerd","sharp"]` (SPEC step 6) as cheap insurance; the
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
