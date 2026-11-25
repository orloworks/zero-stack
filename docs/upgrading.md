# Upgrading an app made with zero-stack

Two separate things change over time: the packages in your app, and the files zero-stack generated for you. Upgrade them one at a time.

## 0. The upgrade command (svelte apps with a `.zero-stack/` folder)

A svelte app made with a zero-stack that records a manifest has a `.zero-stack/` folder (commit it). Upgrade it in one command, from the app's folder, with a clean git tree (commit or stash first; untracked files count) and `bun install` already run (it refuses without `node_modules`: the new version is formatted with your app's own toolchain):

```bash
bunx github:orloworks/zero-stack#v<new-version> upgrade
```

It scaffolds the new version with the flags the manifest recorded into `.zero-stack/upgrade-tmp` (removed afterwards) and prints one line per file it changed:

- an untouched file is **replaced** by the new version;
- a file you edited and the new version also changed is **merged** (your edits stay); a line you both changed is left as conflict markers (`<<<<<<< your app` ... `>>>>>>> zero-stack <new> (new)`), listed as `CONFLICT`, and the command exits 1;
- a file the new version added is **added** when nothing is at that path; one it removed is **removed** when you never edited it;
- a file you deleted stays deleted.

After the per-file lines it prints a summary (counts of replaced, added, removed, merged, kept and in conflict), names every scaffold-owned file you edited with the app-owned file where that change belongs (`You edited src/settings.ts, which zero-stack owns. Declare settings in src/app/settings.ts.`), says to run `bun install` when `package.json` changed, and ends with the two commands that undo it. An app that is already current gets "Nothing to do" and exit 0.

It refuses when `core.autocrlf` is `true` (every file would differ from its recorded copy; run `git config core.autocrlf false` for the app). A change it cannot apply (a binary file you also changed, a path that is a folder, a symlinked folder) is kept as it is, listed, and makes the command exit 1. If a write fails partway it says so and how to undo it.

It never commits, never touches `.env` or your migrations, and never runs a migration. When the database schema changed it says so: run `void db generate` and read the migration before you deploy. After it runs, read `git diff`, run `bun install` if `package.json` changed, run `bun run verify`, and commit.

**To undo it**, in the app's folder: `git checkout .` and `git clean -fd` (the tree was clean before, so that removes only what the upgrade added).

Files that start with "Scaffold-owned by zero-stack" are maintained by zero-stack: put your changes in your own files (`AGENTS.md` lists which are which; the onboarding steps live in `src/app/onboarding.ts` and the runtime settings in `src/app/settings.ts`). An edit in a scaffold-owned file is merged like any other, but it will keep meeting upstream changes.

An app without `.zero-stack/` (made before it existed, or react, vue or solid) is not on the upgrade path: use the manual method below, and for a svelte app port it once.

### Port an older svelte app

For a svelte app made with 0.5.x or earlier (no `.zero-stack/` folder). Do it once, with a clean git tree and `bun install` already run in the app (the upgrade refuses without `node_modules`).

1. Apply the template diff by hand (section 2 below), old = the version your app was made with, new = the version you are porting to, both scaffolded with your app's name and flags. The diff also carries `.zero-stack/` (the manifest and base copy of the new version) and the `.zero-stack/upgrade-tmp` line in `.gitignore`: that is how your app gets them, so there is nothing to copy afterwards. If you edited `SETTINGS` or the onboarding `STEPS`, `src/settings.ts` and `src/onboarding.ts` come out as conflicts: step 2 resolves them.
2. Take the new version's `src/settings.ts` and `src/onboarding.ts` as they are, and put your own `SETTINGS` and `STEPS` into `src/app/settings.ts` and `src/app/onboarding.ts` (the modules import and re-export them, so no import in your code changes). Anything you changed in `auth.ts` stays where it is: the upgrade merges it like any other edit.
3. Compare your app with the fresh scaffold of the new version you made in step 1, and read every difference. Run this in your app's folder (`old/` and `new/` sit next to it, as in section 2):

   ```bash
   diff -rq -x node_modules -x .git -x .env -x .void -x bun.lock -x migrations -x .cloudflare -x .void-wrangler.jsonc ../new/<name> .
   ```

   (Use `diff -u` on a file to see it.) **Each difference must be a change you meant to keep.** `.zero-stack/` now says your app is exactly the new version, so from here on the upgrade treats every difference as your own edit: a hunk of the template diff you missed or resolved wrongly stays that way, and later upstream changes in that region are merged around it or conflict. Fix a missed hunk now by taking the fresh scaffold's file. Your own files (your pages, your dependencies in `package.json`, your lists in `src/app/`) will differ; that is expected.
4. Commit. From then on `bunx github:orloworks/zero-stack#v<new-version> upgrade` works. Running it right away prints "Nothing to do", which only means the record is current: it does not check the port, step 3 does.

Verified once, on a real v0.5.0 scaffold (`--framework svelte --admin`) with edited `SETTINGS` and `STEPS` and a new scaffold of this branch: steps 1 and 2 applied, step 3's diff listed only the two `src/app/` files that hold the edits, `bun run verify` was green, and the upgrade then printed "Nothing to do" (#102).

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
