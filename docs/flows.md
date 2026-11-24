# Flows

User flows the product serves, with the features that hang on each step. Vocabulary: `GLOSSARY.md`. Updated in place by `flows`; one section per flow.

## Upgrade an app

The owner (or a coding agent in the app): when a newer zero-stack has a fix or a feature, they want their app to have it without redoing their own work · Starts: a newer zero-stack release · Ends: the app runs on the new scaffold-owned files, `bun run verify` passes, and the change is one commit the owner reviewed.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Run the upgrade in the app | `zero-stack upgrade`; the manifest | no manifest (an older app, or a react, vue or solid app): point to the one-time port and the manual method · uncommitted changes: refuse and say to commit first · scaffolding the new version fails: nothing in the app changed | 1 |
| Read what changed | the upgrade's summary: files replaced, added and removed; edited scaffold-owned files called out; app-owned files with upstream changes | nothing changed: say so and exit 0 | 1 |
| Resolve conflicts | three-way merge into the working tree, never committed | no conflicts: skip · a conflict: markers in the file, the file listed, non-zero exit · the owner wants out: `git checkout .` and `git clean -fd` restore everything | 2 |
| Migrate the database | a reminder to run `void db generate` and read the migration when the schema changed | schema unchanged: no reminder · running the migration is always the owner's call | 2 |
| Verify and commit | `bun run verify` | red: the summary says which upgraded files to look at first | 1 |

## Change an app without breaking upgrades

The owner (or a coding agent in the app): while building the app, they want to add features, settings, plans, onboarding steps, auth plugins and their own pages without making the next upgrade harder · Starts: any change to a generated app · Ends: the change lives in app-owned files only.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Declare a feature, setting, onboarding step or plan | declaration files | an invalid declaration: the app's tests and build say which one | 1 (one list), 3 (the rest) |
| Add an auth plugin or a trusted origin | the auth extension file | an unsupported key, or a plugin that would replace or switch off a scaffold protection: startup and build fail, naming the plugin and the reason | 4 |
| Restyle or rewrite a user-facing page | app-owned pages | upstream later changes the same lines: a conflict at the next upgrade | 2 |
| Need to change scaffold-owned behaviour | the "scaffold-owned" header; `AGENTS.md` rule | edited anyway: the next upgrade merges it and calls it out | 2 |

## Port an older app (once)

The owner: their app was made before the manifest existed and they want it on the upgrade path · Starts: an app made with zero-stack 0.4.x or earlier · Ends: the app has a manifest and `zero-stack upgrade` reports nothing to do.

| Step | Features | Branches | Slice |
|---|---|---|---|
| Apply the template changes by hand | `docs/upgrading.md` (the manual diff method) | conflicts: resolved by hand, as today | 5 |
| Move the lists into the declaration files and auth edits into the extension file | `docs/upgrading.md` port section | | 5 |
| Adopt the manifest | copy the manifest from a fresh scaffold of the same version and flags | a leftover difference: `zero-stack upgrade` lists the file | 5 |

## Open questions

None open: the planning panel settled the branches above (spec #100).
