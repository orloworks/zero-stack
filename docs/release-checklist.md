# Release checklist

Do these in order on the release commit. Stop at the first failure.

1. `bun run ci:full` is green on the release commit (clean tree, version bumped in `package.json`).
2. Manual deploy check (SPEC.md): scaffold with `--auth`, deploy the app to a throwaway
   Cloudflare account, open it, and sign up. Sign-up must succeed.
3. The `create-void` pin in `src/versions.ts` is current enough (compare with
   `npm view create-void version`). If you bump it, re-run step 1.
4. The name is free before the first publish: `npm view create-zero-stack` returns 404.
5. `npm pack --dry-run` lists the template, skills and routing doc, and no tests, scripts,
   `.ci-cache` or `.env`.
6. Publish: dispatch the Release workflow (`gh workflow run Release --ref <branch>`, needs the
   `NPM_TOKEN` secret) or run `npm publish --access public` by hand. `prepublishOnly` runs
   `ci:full` again.
