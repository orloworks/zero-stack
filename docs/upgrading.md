# Upgrading an app made with zero-stack

Two separate things change over time: the packages in your app, and the files zero-stack generated for you. Upgrade them one at a time.

## 0. The upgrade command (svelte apps with a `.zero-stack/` folder)

A svelte app made with a zero-stack that records a manifest has a `.zero-stack/` folder (commit it). Upgrade it in one command, from the app's folder, with a clean git tree (commit or stash first; untracked files count):

```bash
bunx github:orloworks/zero-stack#v<new-version> upgrade
```

It scaffolds the new version with the flags the manifest recorded into `.zero-stack/upgrade-tmp` (removed afterwards) and prints one line per file it changed:

- an untouched file is **replaced** by the new version;
- a file you edited and the new version also changed is **merged** (your edits stay); a line you both changed is left as conflict markers (`<<<<<<< your app` ... `>>>>>>> zero-stack <new> (new)`), listed as `CONFLICT`, and the command exits 1;
- a file the new version added is **added** when nothing is at that path; one it removed is **removed** when you never edited it;
- a file you deleted stays deleted.

It refuses when `core.autocrlf` is `true` (every file would differ from its recorded copy; run `git config core.autocrlf false` for the app). A change it cannot apply (a binary file you also changed, a path that is a folder, a symlinked folder) is kept as it is, listed, and makes the command exit 1. If a write fails partway it says so and how to undo it.

It never commits, never touches `.env` or your migrations, and never runs a migration. When the database schema changed it says so: run `void db generate` and read the migration before you deploy. After it runs, read `git diff`, run `bun install` if `package.json` changed, run `bun run verify`, and commit.

**To undo it**, in the app's folder: `git checkout .` and `git clean -fd` (the tree was clean before, so that removes only what the upgrade added).

Files that start with "Scaffold-owned by zero-stack" are maintained by zero-stack: put your changes in your own files (`AGENTS.md` lists which are which; the onboarding steps live in `src/app/onboarding.ts`). An edit in a scaffold-owned file is merged like any other, but it will keep meeting upstream changes.

An app without `.zero-stack/` (made before it existed, or react, vue or solid) is not on the upgrade path: use the manual method below, and for a svelte app port it once.

### Port an older svelte app

1. Apply the template diff by hand (section 2 below).
2. Scaffold a fresh app of the same version with the same name and flags, and copy its `.zero-stack/` folder into yours. Add `.zero-stack/upgrade-tmp` to your `.gitignore`.
3. Commit. From then on, `upgrade` works; it lists anything the port missed as a merge or a conflict.

Two separate things change over time: the packages in your app, and the files zero-stack generated for you. Upgrade them one at a time.

## 1. Packages

Dependencies live in your app's own `package.json`. Update them there as you would in any project.

If your app was made with zero-stack 0.4.0 or earlier: set `void` to `1.11.0`, and delete the `@cloudflare/vite-plugin` and `vite-plus` entries under `overrides` if they are there. Then run `bun install` and your app's checks.

## 2. Template changes

Your app is yours; zero-stack never rewrites it. To pull in newer template changes, scaffold the old and the new version with the same name and flags, diff the two, and apply the diff to your app with a three-way merge.

1. Find the zero-stack version your app was made with and the flags you used. Use your app's folder name as `<name>`, so the two scaffolds match your app exactly.
2. Scaffold both versions into separate folders:

   ```bash
   mkdir old new
   (cd old && bunx github:orloworks/zero-stack#v<old-version> <name> <your flags>)
   (cd new && bunx github:orloworks/zero-stack#v<new-version> <name> <your flags>)
   ```

3. Remove what each scaffold generated for itself. `.env` holds a fresh random secret, and migration file names carry a timestamp, so neither belongs in the diff:

   ```bash
   for d in old new; do rm -rf "$d/<name>"/{node_modules,bun.lock,.void,.git,.env,db/migrations}; done
   git diff --no-index --full-index old/<name> new/<name> > upgrade.patch
   ```

4. In your app (committed, clean working tree), store the old files' contents so git can do a real three-way merge, then apply:

   ```bash
   find ../old/<name> -type f | git hash-object -w --stdin-paths > /dev/null
   git apply -p3 --3way ../upgrade.patch
   ```

   Your own edits are kept; a line you and the template both changed shows up as a conflict to resolve.

5. Resolve any conflicts, run `bun install` and your checks, and commit.

## Migrations

Migrations are left out of the diff above. If the new version changed the database schema (look for changes under `db/schema` in the patch), run `void db generate` in your app after applying it, and read the migration it writes before you run it. Whether and when to run it against your data is your call; zero-stack does not decide that for you.
