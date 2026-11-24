# Upgrading an app made with zero-stack

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
