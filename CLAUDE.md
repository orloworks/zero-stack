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

## Agent skills

### Issue tracker

GitHub Issues on `orloworks/zero-stack` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Skill routing
<!-- autopilot: one owner per job; run /autopilot setup to regenerate -->
Use only the owner listed for a job:
- Decisions, glossary, ADRs → grill-with-docs
- UX plan review → /plan-design-review · design system → /design-consultation · visual options → /design-shotgun or prototype
- Architecture → codebase-design, then /plan-eng-review
- Incoming issues and bug reports → triage
- Spec and tickets → to-spec, then to-tickets
- Build → implement-spec (implement for one ticket), with tdd
- Code review → code-review · bugs → diagnosing-bugs · visual polish → /design-review
- Testing the running app → /qa-only (report) or /qa (find and fix); not part of /autopilot build
- Proof → the repo's verify-* skill and /pstack:blast-radius · security → /cso
- Ship (open or update a PR from a branch) → /ship. It bumps VERSION and CHANGELOG, opens the PR, and never merges.
- Deploy (merge and release to production) → /land-and-deploy, which runs the repo's deploy script, then /canary
- Inside /autopilot build, PRs come from implement-spec and merge through the merge gate. /ship is not called there.
- Human only: /office-hours, /autoplan, /pstack:arena
- Not used here: /review, /investigate, /spec, /verify
