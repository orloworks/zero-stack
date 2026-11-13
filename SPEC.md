# zero-stack — Spec V4

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
  installers/       # tailwind, shadcn, zodRpc, auth (anchored string replace)
template/           # file slices copied by installers
docs/cloudflare-routing.md   # single source, see Routing docs
tests/
```

## Pipeline

1. Preflight: spawn `node --version`, require `^24.22 || >=26.12` (Void needs real Node
   on PATH even under bun; `process.versions.node` is unreliable under bun).
2. Target dir must be new or empty. On any failure, delete it wholesale.
3. Validate flags, fail fast with a one-line fix. Only implied flag: `--shadcn` enables
   `--tailwind` and says so. `--shadcn` requires `--framework react`.
4. Run pinned `bunx create-void@<pin> <name> --toolchain vite-plus --framework <fw>
   --starter sqlite --deploy none --git`. It always installs and cannot be prevented.
5. Apply installers by anchored string replace against the known generated output of the
   pinned version. A missing anchor is a hard error (caught by tests on every pin bump).
6. Add `trustedDependencies: ["esbuild","workerd","sharp"]` to package.json (Void does
   not handle bun script approvals). Verified by the scaffold gate.
7. Write the routing block into `AGENTS.md` and a `.mcp.json` with the Cloudflare Docs
   MCP (`https://docs.mcp.cloudflare.com/mcp`). Re-run `bun install` if deps changed.

## Flags

| Flag | Values | Notes |
|---|---|---|
| `--framework` | react (default), vue, svelte, solid | passthrough to create-void |
| `--tailwind` | bool | Tailwind v4 via `@tailwindcss/vite` (Void has no guidance) |
| `--shadcn` | bool | React only, implies `--tailwind` |
| `--zod-rpc` | bool | `@hono/zod-validator` + typed `void/client` helper |
| `--auth` | bool | Void built-in Better Auth wiring, see below |

Starter is fixed to sqlite (D1). No `--ui none`; no API-only mode exists upstream.

## Auth installer

Add `auth` to `void.config.ts`, a minimal sign-in/sign-up page for the chosen framework,
the `@auth-schema` tsconfig alias, run `void db generate` so the migration is committed,
and write a gitignored root `.env` with a random `BETTER_AUTH_SECRET` and
`BETTER_AUTH_URL=http://localhost:5173` plus `.env.example` (no values). Void reads one
root `.env`; `.dev.vars` is unsupported. Social providers are out of scope.

## Generated app

Scripts: `verify` (`void prepare && vp check && vp build && vp test`), `test`,
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
  the full permutation with `vp check`, `vp build`, and `GET /` against `vp dev`
  (the starter page reads D1).
- `bun run ci:full` (before merge and publish): all permutations, at most 2 at once under
  `nice`, shared bun cache, scaffolds skipped when the hash of pins + template is
  unchanged.
- No Playwright. gstack browse may be recommended in generated `AGENTS.md` for agents to
  eyeball UI changes, never in the gate.

## Milestones

- M1: pipeline, preflight, flag validation, cleanup, `create-void` invocation, `ci`.
- M2: tailwind, shadcn, zod-rpc, auth installers, generated scripts and test, `ci:full`.
- M3: routing doc, `AGENTS.md` block, `.mcp.json`, `link-skill`. Manual `npm publish`
  of `create-zero-stack` v0.1.0 only after `ci:full` is green.

## Non-goals for v0.1.0 (revisit in v0.2)

R2 / AI / Durable Object / Turnstile installers, `add` and brownfield `migrate`
commands (Void already ships `void init` for existing apps and a migration skill),
`--json`, MCP server, telemetry, docs site, vendored skills, Renovate/Changesets,
pnpm/npm support, Playwright, magicast, rollback tracker, `void-stack.json`.

## Open facts to verify during build

Bun script trust for workerd/esbuild; `vp install` behaviour with `bun.lock`; whether
`bun create` sets the bun user agent; `cloudflare:` pass-through deploys; custom Worker
exports (Workflows, Agents SDK, Containers) under Void.
