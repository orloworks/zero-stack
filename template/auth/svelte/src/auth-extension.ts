import type { BetterAuthPlugin } from "better-auth";
import { getEndpoints } from "better-auth/api";
import { getAuthTables } from "better-auth/db";

// Guards for the auth extension (src/app/auth.ts). Better Auth lets a later plugin's endpoint replace an earlier one with the same key, and fills any option
// zero-stack leaves unset from a plugin's `init`; so an app plugin could replace account deletion (which cancels billing and purges files first) or switch on email
// verification behind invite-only. Only the app's plugins are wrapped and checked; zero-stack's own are not.
// shortcut: the guards read declarations once, at startup: a plugin that changes its endpoints or its `init` argument later is not caught, upgrade if an app needs one.

type Endpoints = Record<string, { path?: string } | undefined>;
type Schema = Record<string, { fields?: Record<string, unknown> } | undefined>;
export type AuthExtension<A extends BetterAuthPlugin[] = BetterAuthPlugin[]> = { plugins?: A; trustedOrigins?: string[] };

const fail = (reason: string): never => {
  throw new Error(`auth extension (src/app/auth.ts): ${reason}`);
};
const named = (keys: (string | symbol)[]) => keys.map((k) => `"${String(k)}"`).join(", ");
// Same route for the router: case, repeated or trailing slashes and a parameter's name do not make a different path.
const route = (path: string) => path.toLowerCase().replace(/:[^/]+/g, ":").replace(/\/{2,}/g, "/").replace(/\/+$/, "");

// What is taken: Better Auth's own endpoint table and schema, read once from the pinned package (so a new endpoint or field is covered by the version bump alone),
// and, per call, zero-stack's plugins'. Keys are "key <endpoint key>", "path <route>" and "field <model>.<field>".
const note = (taken: Map<string, string>, owner: string, endpoints: Endpoints | undefined, schema: Schema | undefined) => {
  for (const [key, e] of Object.entries(endpoints ?? {})) {
    taken.set(`key ${key}`, owner);
    if (typeof e?.path === "string") taken.set(`path ${route(e.path)}`, owner);
  }
  for (const [model, m] of Object.entries(schema ?? {})) for (const f of Object.keys(m?.fields ?? {})) taken.set(`field ${model}.${f}`, owner);
};
const CORE = new Map<string, string>();
note(CORE, "Better Auth", getEndpoints(Promise.resolve({} as never), {} as never).api as Endpoints, getAuthTables({}) as Schema);

// An origin the router can match exactly: no wildcard, no path, no trailing slash, a scheme.
function origin(o: unknown, where: string): string {
  let ok = false;
  try {
    ok = typeof o === "string" && !/[*?]/.test(o) && new URL(o).origin === o;
  } catch {}
  return ok ? (o as string) : fail(`${where} has the trusted origin ${typeof o === "string" ? JSON.stringify(o) : String(typeof o)}, which is not a plain origin like "https://app.example" (no wildcard, path or trailing slash)`);
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
    // A new field or model is fine; a field a table already has would change how zero-stack's checks read it.
    for (const [model, m] of Object.entries((p.schema ?? {}) as Schema))
      for (const f of Object.keys(m?.fields ?? {})) {
        const by = taken.get(`field ${model}.${f}`);
        if (by) fail(`${name} declares the field "${f}" on "${model}", which ${by} already has`);
      }
    // A rule keeps working on the plugin's own paths and never matches a path Better Auth or zero-stack owns (plugin rules beat the default rules there).
    if (p.rateLimit) {
      const owned = [...taken.keys()].filter((k) => k.startsWith("path ")).map((k) => new RegExp(`^${k.slice(5).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:/g, "[^/]+")}$`));
      p.rateLimit = p.rateLimit.map((r) => ({ ...r, pathMatcher: (path: string) => !owned.some((re) => re.test(route(path))) && r.pathMatcher(path) }));
    }
    const init = p.init;
    if (init)
      p.init = async (ctx) => {
        const before = { password: ctx.password, adapter: ctx.adapter, keys: Object.keys(ctx.options ?? {}).sort().join() };
        const result = await init.call(plugin, ctx);
        if (ctx.password !== before.password || ctx.adapter !== before.adapter || Object.keys(ctx.options ?? {}).sort().join() !== before.keys)
          fail(`${name} changes the password hasher, the adapter or the option names in its init argument`);
        if (!result || typeof result !== "object") return;
        const { options, context } = result;
        if (context) fail(`${name} returns a context from init; a context could replace the password hasher or the adapter`);
        const extra = Reflect.ownKeys(options ?? {}).filter((k) => k !== "databaseHooks" && k !== "trustedOrigins");
        if (extra.length) fail(`${name} returns the option ${named(extra)} from init; only "databaseHooks" and "trustedOrigins" are allowed`);
        if (options?.trustedOrigins !== undefined) origins(options.trustedOrigins, `${name} (init)`);
        // A fresh object with only the two allowed options (cast: Better Auth's generic hook types do not unify with the plugin type here).
        return (options && { options: { ...(options.databaseHooks && { databaseHooks: options.databaseHooks }), ...(options.trustedOrigins && { trustedOrigins: options.trustedOrigins }) } }) as never;
      };
    return p;
  });
  // Typed as Z and A (not the wrapped copies) so the app's `auth` types keep every plugin's endpoints.
  return { plugins: [...zero, ...checked] as [...Z, ...A], trustedOrigins: [...((defaultOrigins as string[] | undefined) ?? []), ...appOrigins] };
}
