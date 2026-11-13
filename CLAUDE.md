# zero-stack

Scaffolder for Void (Cloudflare) apps. Read `SPEC.md` first; it is the source of truth.

- Package manager: bun, single package.
- Never create wrangler files or tell users to; Void generates the Worker config.
- Before Cloudflare work, read `docs/cloudflare-routing.md` and `node_modules/void/docs/`.
- `bun run ci` = fast tier (run before every push). `bun run ci:full` = every
  permutation (run before merge and publish). No GitHub workflow runs on push or PR;
  the release workflow is `workflow_dispatch` only.
- Installers edit generated files by anchored string replace and must fail hard on a
  missing anchor. Bumping `src/versions.ts` requires `ci:full`.
- The CLI writes only inside the target directory and deletes it on failure.
