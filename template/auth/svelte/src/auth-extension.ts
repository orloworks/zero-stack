import type { BetterAuthPlugin } from "better-auth";
import { getEndpoints } from "better-auth/api";
import { getAuthTables } from "better-auth/db";

// Guards for the auth extension (src/app/auth.ts). Better Auth lets a later plugin's endpoint replace an earlier one with the same key, and fills any option
// zero-stack leaves unset from a plugin's `init`; so an app plugin could replace account deletion (which cancels billing and purges files first) or switch on email
// verification behind invite-only. Only the app's plugins are wrapped and checked; zero-stack's own are not.
// shortcut: the guards read declarations once, at startup: a plugin that changes its endpoints or its `init` argument later is not caught, upgrade if an app needs one.

type Endpoints = Record<string, { path?: string } | undefined>;
type Schema = Record<string, { modelName?: unknown; disableMigration?: unknown; fields?: Record<string, { fieldName?: unknown } | undefined> } | undefined>;
export type AuthExtension<A extends BetterAuthPlugin[] = BetterAuthPlugin[]> = { plugins?: A; trustedOrigins?: string[] };

const fail = (reason: string): never => {
  throw new Error(`auth extension (src/app/auth.ts): ${reason}`);
};
const named = (keys: (string | symbol)[]) => keys.map((k) => `"${String(k)}"`).join(", ");
// Same route for the router: case, repeated or trailing slashes and a parameter's name do not make a different path.
const route = (path: string) => path.toLowerCase().replace(/:[^/]+/g, ":").replace(/\/{2,}/g, "/").replace(/\/+$/, "");

// What is taken: Better Auth's own endpoint table and schema, read once from the pinned package (so a new endpoint or field is covered by the version bump alone),
// and, per call, zero-stack's plugins'. Keys are "key <endpoint key>", "path <route>", "model <model>" and "field <model>.<field>" (a field is taken under its
// key and under the column it writes, its `fieldName`).
const note = (taken: Map<string, string>, owner: string, endpoints: Endpoints | undefined, schema: Schema | undefined) => {
  for (const [key, e] of Object.entries(endpoints ?? {})) {
    taken.set(`key ${key}`, owner);
    if (typeof e?.path === "string") taken.set(`path ${route(e.path)}`, owner);
  }
  for (const [model, m] of Object.entries(schema ?? {})) {
    taken.set(`model ${model}`, owner);
    if (typeof m?.modelName === "string" && m.modelName !== model) taken.set(`name ${model}`, m.modelName);
    for (const [f, d] of Object.entries(m?.fields ?? {})) for (const n of columns(f, d)) taken.set(`field ${model}.${n}`, owner);
  }
};
// A comparable picture of a value, nested: an init gets the live context, so a change inside it (rate limiting off, an origin added, email verification
// off) would otherwise pass. Functions are told apart by identity. Never printed: it can hold the secret.
function picture(v: unknown, ids = new Map<unknown, number>(), depth = 0): string {
  if (typeof v === "function") return `fn${ids.get(v) ?? (ids.set(v, ids.size), ids.size - 1)}`;
  if (v === null || typeof v !== "object" || depth > 6) return `${typeof v}:${String(v)}`;
  if (v instanceof Map) return `map${picture([...v], ids, depth + 1)}`; // the secret can be a key map
  if (Array.isArray(v)) return `[${v.map((x) => picture(x, ids, depth + 1)).join()}]`;
  return `{${Object.keys(v).sort().map((k) => `${k}=${picture((v as Record<string, unknown>)[k], ids, depth + 1)}`).join()}}`;
}
const columns = (key: string, d: { fieldName?: unknown } | undefined) => (typeof d?.fieldName === "string" && d.fieldName !== key ? [key, d.fieldName] : [key]);
const CORE = new Map<string, string>();
note(CORE, "Better Auth", getEndpoints(Promise.resolve({} as never), {} as never).api as Endpoints, getAuthTables({}) as Schema);

// An origin the router can match exactly: no wildcard, no path, no trailing slash, a scheme.
function origin(o: unknown, where: string): string {
  let ok = false;
  let meant = "";
  try {
    const exact = typeof o === "string" && !/[*?]/.test(o) ? new URL(o).origin : "";
    ok = exact === o;
    if (!ok && /^https?:\/\//.test(exact)) meant = `; did you mean "${exact}"?`;
  } catch {}
  return ok
    ? (o as string)
    : fail(`${where} has the trusted origin ${typeof o === "string" ? JSON.stringify(o) : String(typeof o)}, which is not a plain origin like "https://app.example" (lowercase host, no default port, wildcard, path or trailing slash)${meant}`);
}
const origins = (list: unknown, where: string): string[] => (Array.isArray(list) ? list.map((o) => origin(o, where)) : fail(`${where} gives trustedOrigins as ${typeof list}, not a list of origins`));

export function extendAuth<Z extends BetterAuthPlugin[], A extends BetterAuthPlugin[]>(zero: Z, ext: AuthExtension<A>, defaultOrigins?: unknown) {
  if (!ext || typeof ext !== "object") fail("it must return { plugins, trustedOrigins }");
  const unknown = Reflect.ownKeys(ext).filter((k) => k !== "plugins" && k !== "trustedOrigins");
  if (unknown.length) fail(`it returns the key ${named(unknown)}; only "plugins" and "trustedOrigins" are allowed`);
  const { plugins = [] as unknown as A, trustedOrigins = [] } = ext;
  if (!Array.isArray(plugins)) fail('"plugins" must be a list of plugins');
  const appOrigins = origins(trustedOrigins, "the extension");
  // Void's defaults: absent is allowed, anything but a list of strings is not (the app's origins are added to them, never in place of them).
  if (defaultOrigins !== undefined && !(Array.isArray(defaultOrigins) && defaultOrigins.every((o) => typeof o === "string"))) fail("Void's default trustedOrigins is not a list of strings");

  const taken = new Map(CORE);
  for (const z of zero) note(taken, `the plugin "${z.id}"`, z.endpoints as Endpoints | undefined, z.schema as Schema | undefined);

  const checked = plugins.map((plugin) => {
    const p = { ...plugin }; // one snapshot: what is checked is what runs
    const name = `the plugin "${String(p.id)}"`;
    if (typeof p.id !== "string" || !p.id) fail("a plugin has no id");
    if (zero.some((z) => z.id === p.id)) fail(`${name} has the same id as one of zero-stack's plugins`);
    if (p.endpoints) p.endpoints = { ...p.endpoints };
    for (const [key, e] of Object.entries((p.endpoints ?? {}) as Endpoints)) {
      const byKey = taken.get(`key ${key}`);
      if (byKey) fail(`${name} defines the endpoint "${key}", which ${byKey} already has`);
      const byPath = typeof e?.path === "string" && taken.get(`path ${route(e.path)}`);
      if (byPath) fail(`${name} defines the endpoint "${key}" at the path "${e!.path}", which ${byPath} already has`);
    }
    // A new field or model is fine. A field a table already has (by its key or by the column it writes) would change how zero-stack's checks read it,
    // and renaming an existing table or switching off its migration would leave those checks reading an empty table (the last plugin to say so wins).
    for (const [model, m] of Object.entries((p.schema ?? {}) as Schema)) {
      const owner = taken.get(`model ${model}`);
      if (owner && (m?.modelName !== undefined || m?.disableMigration !== undefined)) fail(`${name} sets modelName or disableMigration on "${model}", a table ${owner} already has`);
      // Better Auth takes the table name from the last plugin that mentions the table, and an entry with no modelName resets it to the key.
      if (owner && taken.has(`name ${model}`)) fail(`${name} adds to "${model}", which ${owner} stores under the name "${taken.get(`name ${model}`)}"; that would reset the table's name`);
      for (const [f, d] of Object.entries(m?.fields ?? {}))
        for (const n of columns(f, d)) {
          const by = taken.get(`field ${model}.${n}`);
          if (by) fail(`${name} declares the field "${f}"${n === f ? "" : ` (column "${n}")`} on "${model}", which ${by} already has`);
        }
    }
    // A rule keeps working on the plugin's own paths and never matches a path Better Auth or zero-stack owns (plugin rules beat the default rules there).
    if (p.rateLimit && !Array.isArray(p.rateLimit)) fail(`${name} gives rateLimit as ${typeof p.rateLimit}, not a list of rules`);
    if (p.rateLimit) {
      const owned = [...taken.keys()].filter((k) => k.startsWith("path ")).map((k) => new RegExp(`^${k.slice(5).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:/g, "[^/]+")}$`));
      p.rateLimit = p.rateLimit.map((r) => ({ ...r, pathMatcher: (path: string) => !owned.some((re) => re.test(route(path))) && r.pathMatcher(path) }));
    }
    const init = p.init;
    if (init)
      p.init = async (ctx) => {
        const ids = new Map<unknown, number>();
        const guarded = () => {
          const c = ctx as unknown as Record<string, unknown>;
          const o = (ctx.options ?? {}) as Record<string, unknown>;
          return picture([c.rateLimit, c.trustedOrigins, c.secret, c.secretConfig, c.skipOriginCheck, c.skipCSRFCheck, c.sessionConfig, c.oauthConfig, c.trustedProviders, c.authCookies, o.rateLimit, o.trustedOrigins, o.emailAndPassword, o.emailVerification, o.advanced, o.session, o.user, o.account], ids);
        };
        const before = { password: ctx.password, adapter: ctx.adapter, keys: Object.keys(ctx.options ?? {}).sort().join(), guarded: guarded() };
        const result = await init.call(plugin, ctx);
        if (ctx.password !== before.password || ctx.adapter !== before.adapter || Object.keys(ctx.options ?? {}).sort().join() !== before.keys)
          fail(`${name} changes the password hasher, the adapter or the option names in its init argument`);
        if (guarded() !== before.guarded) fail(`${name} changes rate limiting, trusted origins, sessions or an auth option inside its init argument; return databaseHooks or trustedOrigins from init instead`);
        if (!result || typeof result !== "object") return;
        const { options, context } = result;
        if (context) fail(`${name} returns a context from init; a context could replace the password hasher or the adapter`);
        const extra = Reflect.ownKeys(options ?? {}).filter((k) => k !== "databaseHooks" && k !== "trustedOrigins");
        if (extra.length) fail(`${name} returns the option ${named(extra)} from init; only "databaseHooks" and "trustedOrigins" are allowed`);
        if (!options) return;
        // Each value is read once, so what was checked is what is returned (a getter cannot answer differently the second time).
        const hooks = options.databaseHooks;
        const listed = options.trustedOrigins;
        const trusted = listed === undefined ? undefined : origins(listed, `${name} (init)`);
        // A fresh object with only the two allowed options (cast: Better Auth's generic hook types do not unify with the plugin type here).
        return { options: { ...(hooks && { databaseHooks: hooks }), ...(trusted && { trustedOrigins: trusted }) } } as never;
      };
    return p;
  });
  // Typed as Z and A (not the wrapped copies) so the app's `auth` types keep every plugin's endpoints.
  return { plugins: [...zero, ...checked] as [...Z, ...A], trustedOrigins: [...((defaultOrigins as string[] | undefined) ?? []), ...appOrigins] };
}
