// Your auth extension: add Better Auth plugins and trusted origins here instead of editing auth.ts, which zero-stack maintains and rewrites on upgrade.
// auth.ts calls this once, appends your plugins after zero-stack's and adds your origins to Void's trusted origins. Return exactly these two keys.
//
// - Lazy imports: auth.ts is loaded at startup and at build, where bindings and the generated auth schema do not exist. Import the database, mail and storage
//   modules inside the functions that use them (`await import("../db")`), never at the top of this file or of a file it imports.
// - Hooks: put them in a small plugin of your own (`{ id: "my-hooks", hooks: { before: [...], after: [...] } }`, as the invite-only plugin in auth.ts does) and list
//   it in `plugins`. There is no slot for hooks, database hooks, social providers or session options here.
// - Guards: the app refuses to start (the error names the plugin and the reason) when a plugin has the id of one of zero-stack's plugins; defines an endpoint whose
//   key or path Better Auth or one of zero-stack's plugins already has (a later endpoint replaces an earlier one, so it could replace account deletion); or has an
//   `init` that returns anything but `databaseHooks` and `trustedOrigins` (other options fill what zero-stack leaves unset, and a returned context replaces the
//   password hasher or the adapter). The `init` check runs when Better Auth builds its context, so it fails the first auth request; the others fail at startup.
// - Known limits: the guards stop replacement by declaration. They do not stop a plugin whose hook deliberately answers or rewrites a request (`hooks`, `onRequest`,
//   `middlewares`, `rateLimit` rules; database hooks from an `init` run before zero-stack's own, so they can rewrite the data those see), or an `init` that changes its
//   argument in place. Read a plugin before you add it.
export default function authExtension(_env: Record<string, unknown>) {
  return { plugins: [], trustedOrigins: [] };
}
