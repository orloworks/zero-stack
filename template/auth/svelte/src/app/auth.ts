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
//   password hasher or the adapter). Also refused: a trusted origin that is not a plain origin like "https://app.example" (no wildcard, path or trailing slash; from here
//   or from an `init`); a plugin `schema` field its model already has (new fields and models are fine); an `init` that changes the password hasher, the adapter or the option
//   names of its argument. A plugin's `rateLimit` rules never match a path Better Auth or zero-stack owns. The `init` checks run when Better Auth builds its context, so they
//   fail the first auth request; the others fail at startup.
// - Known limits: the guards stop replacement by declaration. They do not stop a plugin whose `hooks`, `onRequest` or `middlewares` deliberately answer or rewrite a
//   request, or an `init` that changes something inside its argument that the guard does not compare (it compares the secret and its key config, the origin and CSRF check switches, rate limiting, trusted origins, sessions, cookies, OAuth and trusted-provider settings, and the options emailAndPassword, emailVerification, advanced, session, user, account and rateLimit; nothing else). App database hooks run first, so zero-stack's checks (invite-only) see the final data.
//   Read a plugin before you add it.
export default function authExtension(_env: Record<string, unknown>) {
  return { plugins: [], trustedOrigins: [] };
}
