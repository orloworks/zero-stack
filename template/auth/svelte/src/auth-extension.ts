import type { BetterAuthPlugin } from "better-auth";
import { getEndpoints } from "better-auth/api";

// Guards for the auth extension (src/app/auth.ts). Better Auth lets a later plugin's endpoint replace an earlier one with the same key, and fills any option
// zero-stack leaves unset from a plugin's `init`; so an app plugin could replace account deletion (which cancels billing and purges files first) or switch on email
// verification behind invite-only. Only the app's plugins are wrapped and checked; zero-stack's own are not.
// shortcut: the guards read declarations once, at startup: a plugin that changes its endpoints or its `init` argument later is not caught, upgrade if an app needs one.

type Endpoints = Record<string, { path?: string } | undefined>;
export type AuthExtension<A extends BetterAuthPlugin[] = BetterAuthPlugin[]> = { plugins?: A; trustedOrigins?: string[] };

const fail = (reason: string): never => {
  throw new Error(`auth extension (src/app/auth.ts): ${reason}`);
};
const named = (keys: (string | symbol)[]) => keys.map((k) => `"${String(k)}"`).join(", ");
// Same route for the router: case, a trailing slash and a parameter's name do not make a different path.
const route = (path: string) => path.toLowerCase().replace(/:[^/]+/g, ":").replace(/\/+$/, "");

export function extendAuth<Z extends BetterAuthPlugin[], A extends BetterAuthPlugin[]>(zero: Z, ext: AuthExtension<A>) {
  if (!ext || typeof ext !== "object") fail("it must return { plugins, trustedOrigins }");
  const unknown = Reflect.ownKeys(ext).filter((k) => k !== "plugins" && k !== "trustedOrigins");
  if (unknown.length) fail(`it returns the key ${named(unknown)}; only "plugins" and "trustedOrigins" are allowed`);
  const { plugins = [] as unknown as A, trustedOrigins = [] } = ext;
  if (!Array.isArray(plugins) || !Array.isArray(trustedOrigins) || trustedOrigins.some((o) => typeof o !== "string"))
    fail('"plugins" must be a list of plugins and "trustedOrigins" a list of origin strings');

  // What is taken: Better Auth's own endpoint table (read here, so a new Better Auth endpoint is covered by the version bump alone) and zero-stack's plugins'.
  const taken = new Map<string, string>();
  const take = (owner: string, endpoints: Endpoints | undefined) => {
    for (const [key, e] of Object.entries(endpoints ?? {})) {
      taken.set(`key ${key}`, owner);
      if (typeof e?.path === "string") taken.set(`path ${route(e.path)}`, owner);
    }
  };
  take("Better Auth", getEndpoints(Promise.resolve({} as never), {} as never).api as Endpoints);
  for (const z of zero) take(`the plugin "${z.id}"`, z.endpoints as Endpoints | undefined);

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
    const init = p.init;
    if (init)
      p.init = async (ctx) => {
        const result = await init.call(plugin, ctx);
        if (!result || typeof result !== "object") return;
        const { options, context } = result;
        if (context) fail(`${name} returns a context from init; a context could replace the password hasher or the adapter`);
        const extra = Reflect.ownKeys(options ?? {}).filter((k) => k !== "databaseHooks" && k !== "trustedOrigins");
        if (extra.length) fail(`${name} returns the option ${named(extra)} from init; only "databaseHooks" and "trustedOrigins" are allowed`);
        // A fresh object with only the two allowed options (cast: Better Auth's generic hook types do not unify with the plugin type here).
        return (options && { options: { ...(options.databaseHooks && { databaseHooks: options.databaseHooks }), ...(options.trustedOrigins && { trustedOrigins: options.trustedOrigins }) } }) as never;
      };
    return p;
  });
  // Typed as Z and A (not the wrapped copies) so the app's `auth` types keep every plugin's endpoints.
  return { plugins: [...zero, ...checked] as [...Z, ...A], trustedOrigins: [...trustedOrigins] };
}
