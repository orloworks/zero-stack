# Upgrading an app made with zero-stack

Two separate things change over time: the packages in your app, and the files zero-stack generated for you. Upgrade them one at a time.

## 1. Packages

Dependencies live in your app's own `package.json`. Update them there as you would in any project.

If your app was made with zero-stack 0.4.0 or earlier, do this once: set `void` to `1.11.0` and delete the two `overrides` entries zero-stack used to add. Then run `bun install` and your app's checks.

## 2. Template changes

Your app is yours; zero-stack never rewrites it. To pull in newer template changes, scaffold the old and the new version with the same flags, diff the two, and apply the diff to your app.

1. Find the version your app was made with and the flags you used (the answers to the zero-stack prompts).
2. Scaffold both versions into empty folders, with the same name and flags:

   ```bash
   bunx create-zero-stack@<old-version> old-app <your flags>
   bunx create-zero-stack@<new-version> new-app <your flags>
   ```

3. Diff them:

   ```bash
   git diff --no-index --no-prefix old-app new-app > upgrade.patch
   ```

4. In your app, apply the patch with a three-way merge, so your own edits are kept and real clashes show up as conflict markers:

   ```bash
   git apply --3way upgrade.patch
   ```

5. Resolve any conflicts, run your checks, and commit.

Leave out lock files, `.void/` and other generated output when you diff.

## Migrations

If the diff contains a database migration, read it before you apply it. Whether and when to run it against your data is your call; zero-stack does not decide that for you.
