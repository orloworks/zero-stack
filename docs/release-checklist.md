# Release checklist

zero-stack is distributed from GitHub, not npm. Users run `bunx github:orloworks/zero-stack#v<version> <dir>`, and a release is a git tag. Do these in order. Stop at the first failure.

1. On a release branch, bump `version` in `package.json`, add a `CHANGELOG.md` entry, and update the tag in the README's usage line.
2. `bun scripts/ci-full.ts --force` is green on the release commit, with a clean tree.
3. The `create-void` pin in `src/versions.ts` is current enough (compare with `npm view create-void version`). If you bump it, re-run step 2.
4. Merge the release PR. Then tag the merge commit and create the release (neither triggers Actions):
   `git tag v<version> <sha> && git push origin v<version> && gh release create v<version> --notes-file <notes>`
5. Smoke-test the tag from an empty temp dir: `bunx github:orloworks/zero-stack#v<version> app --framework svelte --auth`, then run `bun run verify` in `app`.
6. Move the upgrade baseline (`UPGRADE_BASELINE` in `src/versions.ts`) to the PREVIOUS release: the newest tag, older than the one being cut, whose scaffold writes a manifest. Never to the release being cut: the baseline would then equal this code, the upgrade would change nothing, and the gate fails ("too new"). Use that tag's commit sha, on a branch, and run `bun scripts/gate.ts --framework svelte --admin --baseline` before merging it (the gate fetches the baseline from GitHub). At the first release that carries the seam, leave the current commit pin (the merge of #101) as it is; at the release after it, move the pin to that first tag.
7. Optional, done by the owner: deploy that app to a throwaway Cloudflare account and sign up.

A tag is never moved. A bad release gets a new patch version.
