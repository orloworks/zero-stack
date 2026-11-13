# create-zero-stack

Scaffold a [Void](https://void.cloud) app for Cloudflare Workers with opinionated extras
(Tailwind, shadcn, zod RPC, auth). It wraps `create-void@1.8.0` (the pin in
`src/versions.ts`) and layers installers on top by anchored string replace. Personal-first
tool, published without support promises.

## Requirements

- [bun](https://bun.sh)
- Real Node `^24.22 || >=26.12` on `PATH` (Void needs it even when you run under bun)

## Usage

```sh
bun create zero-stack my-app
# or
bunx create-zero-stack my-app
```

Run it without arguments in a terminal for prompts. The target directory must be new or
empty; on any failure it is deleted. The CLI writes only inside that directory.

| Flag | Values | Notes |
|---|---|---|
| `--framework` | react (default), vue, svelte, solid | passthrough to create-void |
| `--tailwind` | bool | Tailwind v4 via `@tailwindcss/vite` |
| `--shadcn` | bool | React only, implies `--tailwind` |
| `--zod-rpc` | bool | Void `defineHandler.withValidator` with a zod body schema and a typed `void/client` call |
| `--auth` | bool | Void built-in Better Auth wiring, sign-in/up pages, migration, `.env` with a random secret |

The starter is fixed to sqlite (D1).

## What gets generated

A `create-void` app (vite-plus toolchain, sqlite starter, git) plus your chosen installers,
`vp check --fix` applied, `trustedDependencies` for esbuild/workerd/sharp, and:

- scripts `verify`, `test`, `db:reset`, and one `vi.mock`-based route test
- `AGENTS.md` with a Cloudflare routing block and the rule to run `verify` before finishing
- `.mcp.json` with the Cloudflare Docs MCP

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
