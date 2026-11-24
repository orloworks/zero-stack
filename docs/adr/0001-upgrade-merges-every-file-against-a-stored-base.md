# Upgrades merge every file against a stored base copy

A generated app keeps a manifest (version, name, framework, flags) and a base copy of every file as zero-stack last generated it. `zero-stack upgrade` scaffolds the new version with the same name and flags and three-way-merges every file (base copy, the app's file, the new version): an untouched file becomes the new version, an edited one is merged, and a conflict is left as markers, listed, and makes the command exit non-zero. It needs a clean git tree, never commits, and never touches `.env` or migrations, so `git checkout .` and `git clean -fd` undo it.

Ownership (scaffold-owned or app-owned) is a label: it decides the notice at the top of a file, what `AGENTS.md` tells coding agents, and what the upgrade report says about an edited file. It does not decide whether a file is overwritten.

## Considered options

- **Hashes of scaffold-owned files, overwrite when untouched, refuse or `--force` when edited** (the first proposal). Rejected: `--force` drops an edit that only shows at runtime, and it is a second mechanism beside the merge that app-owned files need anyway. With a base copy the hash adds nothing.
- **Scaffold the old version from its tag at upgrade time instead of storing a base.** Rejected: needs the network and an old dependency set that still installs.
- **Publish the machinery as an npm package.** Rejected for now: a new runtime dependency and a package to maintain.

## Consequences

The base copy is a few hundred KB committed in each app, stored as one file so the test runner, the linter and the type checker never see it. The stored format carries a format version so a later change can migrate it. Only svelte apps get the manifest and the base copy; react, vue and solid output is unchanged and those apps stay on `docs/upgrading.md`.
