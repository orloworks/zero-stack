import { expect, it, vi } from "vite-plus/test";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, emailOTP } from "better-auth/plugins";
import { extendAuth } from "../src/auth-extension";

// What src/app/auth.ts returns, for the one test that loads the composed auth.ts. Tests run in Node without Worker bindings, so defineAuth just hands back the options.
const app = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("../src/app/auth", () => ({ default: () => app.value }));
vi.mock("void/auth", () => ({ defineAuth: (fn: unknown) => fn }));

// The first test's cold import of Better Auth takes seconds on a loaded machine; the 5s default flakes.
const SLOW = 30_000;

const endpoint = (path: string) => createAuthEndpoint(path, { method: "POST" }, async (ctx) => ctx.json({ ok: true }));
// A plugin id and endpoint of zero-stack's own, for the clash cases.
const zero = [{ id: "zero-plugin", endpoints: { zeroThing: endpoint("/zero/thing") }, schema: { user: { fields: { zeroRole: { type: "string" as const, required: false } } } } }];

// A real Better Auth instance with the extension's plugins, as the app builds it. Better Auth runs a plugin's `init` while it builds its context, so a refused
// init shows as a rejected context. Hashing is not under test (scrypt makes every sign-up slow), so it is swapped for a plain compare.
function start(plugins: unknown[]) {
  return betterAuth({
    plugins: extendAuth([], { plugins: plugins as never }).plugins,
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:5173",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, password: { hash: async (p: string) => p, verify: async ({ hash, password }: { hash: string; password: string }) => hash === password } },
  });
}
const refuses = (plugins: unknown[], ...texts: string[]) => {
  let message = "";
  try {
    extendAuth(zero as never, { plugins: plugins as never });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).not.toBe("");
  for (const t of texts) expect(message).toContain(t);
};

it("an app plugin that redefines the delete endpoint by key is refused, naming the plugin and the key", () => {
  refuses([{ id: "evil", endpoints: { deleteUser: endpoint("/evil/delete") } }], '"evil"', '"deleteUser"');
});

it("an app plugin that reuses the delete endpoint's path under another key is refused, naming the plugin and the key", () => {
  refuses([{ id: "evil", endpoints: { mine: endpoint("/delete-user") } }], '"evil"', '"mine"', "/delete-user");
  refuses([{ id: "evil", endpoints: { mine: endpoint("/Delete-User/") } }], '"evil"', '"mine"'); // case and a trailing slash are the same route
});

it("an endpoint that clashes with a zero-stack plugin's by key or by path is refused", () => {
  refuses([{ id: "evil", endpoints: { zeroThing: endpoint("/evil/x") } }], '"evil"', '"zeroThing"', "zero-plugin");
  refuses([{ id: "evil", endpoints: { other: endpoint("/zero/thing") } }], '"evil"', '"other"', "zero-plugin");
});

it("a plugin id that equals one of zero-stack's is refused", () => {
  refuses([{ id: "zero-plugin" }], '"zero-plugin"');
});

it("repeated slashes do not make another route", () => {
  // Better Auth's own builder refuses these, so the plugins are written by hand.
  refuses([{ id: "evil", endpoints: { a: { path: "//delete-user" } } }], '"evil"', '"a"');
  refuses([{ id: "evil", endpoints: { b: { path: "/zero//thing" } } }], '"evil"', '"b"', "zero-plugin");
});

it("a rate-limit rule never matches a path Better Auth or zero-stack owns, and still applies to the plugin's own", () => {
  const rule = { window: 1, max: 1_000_000, pathMatcher: () => true };
  const mine = { id: "loose", endpoints: { mine: endpoint("/loose/ping") }, rateLimit: [rule] };
  const [wrapped] = extendAuth(zero as never, { plugins: [mine] as never }).plugins.at(-1)!.rateLimit!;
  for (const owned of ["/sign-in/email", "/sign-up/email", "/delete-user", "/zero/thing", "/reset-password/abc", "/Sign-In/Email/"]) expect([owned, wrapped!.pathMatcher(owned)]).toEqual([owned, false]);
  expect(wrapped!.pathMatcher("/loose/ping")).toBe(true);
  expect(wrapped!.max).toBe(rule.max);
});

it("trusted origins must be plain origins, from the extension and from an init", async () => {
  for (const bad of ["*", "https://*", "https://app.example/", "https://app.example/x", "app.example", "https://app.example?x"])
    expect(() => extendAuth([], { trustedOrigins: [bad] })).toThrow(JSON.stringify(bad));
  expect(() => extendAuth([], { trustedOrigins: (() => []) as never })).toThrow("not a list");
  expect(extendAuth([], { trustedOrigins: ["https://app.example", "http://localhost:3000"] }, ["http://localhost:5173"]).trustedOrigins).toEqual(["http://localhost:5173", "https://app.example", "http://localhost:3000"]);
  await expect(start([{ id: "wild", init: () => ({ options: { trustedOrigins: ["https://*.example"] } }) }]).$context).rejects.toThrow(/"wild".*"https:\/\/\*\.example"/);
  await expect(start([{ id: "fn", init: () => ({ options: { trustedOrigins: () => ["https://app.example"] } }) }]).$context).rejects.toThrow(/"fn".*not a list/);
}, SLOW);

it("Void's default origins must be a list of strings when given", () => {
  expect(() => extendAuth([], {}, "https://app.example")).toThrow("default trustedOrigins");
  expect(() => extendAuth([], {}, [1])).toThrow("default trustedOrigins");
  expect(extendAuth([], {}, undefined).trustedOrigins).toEqual([]);
});

it("a plugin schema may add fields and models, but not a field its model already has in Better Auth or zero-stack", () => {
  for (const field of ["emailVerified", "email", "zeroRole"]) refuses([{ id: "evil", schema: { user: { fields: { [field]: { type: "string" } } } } }], '"evil"', `"${field}"`);
  refuses([{ id: "evil", schema: { session: { fields: { token: { type: "string" } } } } }], '"evil"', '"token"');
  const fine = { id: "fine", schema: { user: { fields: { nickname: { type: "string", required: false } } }, note: { modelName: "notes", fields: { text: { type: "string" } } } } };
  expect(() => extendAuth(zero as never, { plugins: [fine] as never })).not.toThrow();
});

it("a plugin schema may not rename an existing table, switch off its migration, or point a new field at an existing column", () => {
  // The last plugin to set modelName or disableMigration wins in Better Auth, so zero-stack's checks would read another, empty table.
  refuses([{ id: "evil", schema: { user: { modelName: "people", fields: {} } } }], '"evil"', "modelName", '"user"');
  refuses([{ id: "evil", schema: { session: { disableMigration: true, fields: {} } } }], '"evil"', "disableMigration", '"session"');
  // A new key that writes an existing column is the same field under another name.
  refuses([{ id: "evil", schema: { user: { fields: { verified: { type: "boolean", fieldName: "emailVerified" } } } } }], '"evil"', '"verified"', '"emailVerified"');
  refuses([{ id: "evil", schema: { user: { fields: { mine: { type: "string", fieldName: "zeroRole" } } } } }], '"evil"', '"mine"', "zero-plugin");
});

it("an init's trusted origins are read once: what was checked is what is used", async () => {
  let reads = 0;
  const options = { get trustedOrigins() { return reads++ ? ["*"] : ["https://app.example"]; } };
  const ctx = await start([{ id: "twice", init: () => ({ options }) }]).$context;
  expect(reads).toBe(1);
  expect(JSON.stringify(ctx.options.trustedOrigins ?? [])).not.toContain("*");
}, SLOW);

it("a refused origin says what was meant when it is only spelled differently, and a rate limit that is not a list is refused by name", () => {
  expect(() => extendAuth([], { trustedOrigins: ["https://App.Example:443"] })).toThrow('did you mean "https://app.example"?');
  refuses([{ id: "odd", rateLimit: { max: 1 } }], '"odd"', "rateLimit");
});

it("an init that changes the password hasher, the adapter or the option names of its argument is refused", async () => {
  await expect(start([{ id: "hash", init: (ctx: any) => void (ctx.password = { ...ctx.password }) }]).$context).rejects.toThrow(/"hash".*in its init argument/);
  await expect(start([{ id: "adapt", init: (ctx: any) => void (ctx.adapter = { ...ctx.adapter }) }]).$context).rejects.toThrow(/"adapt".*in its init argument/);
  await expect(start([{ id: "opt", init: (ctx: any) => void (ctx.options.emailVerification = { sendOnSignUp: true }) }]).$context).rejects.toThrow(/"opt".*in its init argument/);
}, SLOW);

it("an unknown key from the extension is refused, naming the key", () => {
  expect(() => extendAuth([], { plugins: [], origins: [] } as never)).toThrow('"origins"');
  expect(() => extendAuth([], undefined as never)).toThrow("it must return");
  expect(() => extendAuth([], { trustedOrigins: [1] } as never)).toThrow("plain origin");
});

it("an init that returns advanced, or a real plugin whose init sets email verification, stops the app starting", async () => {
  await expect(start([{ id: "tweak", init: () => ({ options: { advanced: { disableCSRFCheck: true } } }) }]).$context).rejects.toThrow(/"tweak".*"advanced"/);
  await expect(start([emailOTP({ overrideDefaultEmailVerification: true, sendVerificationOTP: async () => {} })]).$context).rejects.toThrow(/"email-otp".*"emailVerification"/);
}, SLOW);

it("an init that returns a context is refused, even next to allowed options", async () => {
  await expect(start([{ id: "swap", init: async () => ({ context: { password: {} } }) }]).$context).rejects.toThrow(/"swap".*context/);
  await expect(start([{ id: "swap", init: () => ({ options: { trustedOrigins: [] }, context: { adapter: {} } }) }]).$context).rejects.toThrow(/"swap".*context/);
}, SLOW);

it("a real plugin whose init returns only database hooks starts, and its hook fires", async () => {
  const db = { user: [] as Record<string, unknown>[], session: [], account: [], verification: [] };
  const auth = betterAuth({
    plugins: extendAuth([], { plugins: [admin()] }).plugins,
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:5173",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, password: { hash: async (p: string) => p, verify: async ({ hash, password }: { hash: string; password: string }) => hash === password } },
  });
  await auth.api.signUpEmail({ body: { name: "Ada", email: "ada@example.com", password: "correct-horse-battery" } });
  expect(db.user[0]?.role).toBe("user"); // the admin plugin's database hook set it
}, SLOW);

it("an init that returns trusted origins, an async init, an init that returns nothing and a plugin without init all start", async () => {
  const auth = start([
    { id: "origins", init: () => ({ options: { trustedOrigins: ["https://app.example"] } }) },
    { id: "async", init: async () => {} },
    { id: "nothing", init() {} },
    { id: "plain" },
  ]);
  expect((await auth.$context).options.trustedOrigins).toContain("https://app.example");
}, SLOW);

it("auth.ts appends the app's plugins after zero-stack's and adds its origins to the defaults, without spreading the app's object", async () => {
  const mine = { id: "mine", hooks: { before: [] } };
  app.value = { plugins: [mine], trustedOrigins: ["https://app.example"] };
  const { default: define } = (await import("../auth")) as any;
  const defaults = { trustedOrigins: ["http://localhost:5173"], baseURL: "http://localhost:5173" };
  const env = { STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_placeholder", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", BETTER_AUTH_URL: "http://localhost:5173" };
  const options = define({ defaults, env });
  expect(options.plugins.at(-1).id).toBe("mine");
  expect(options.plugins.filter((p: { id: string }) => p.id === "mine")).toHaveLength(1);
  expect(options.trustedOrigins).toEqual(["http://localhost:5173", "https://app.example"]);
  // an unknown key from the extension stops the app; so does a plugin that takes zero-stack's account deletion
  expect(() => define({ defaults: { ...defaults, trustedOrigins: "https://x" }, env })).toThrow("default trustedOrigins");
  app.value = { plugins: [], hooks: {} };
  expect(() => define({ defaults, env })).toThrow('"hooks"');
  app.value = { plugins: [{ id: "evil", endpoints: { deleteUser: endpoint("/evil/delete") } }] };
  expect(() => define({ defaults, env })).toThrow('"deleteUser"');
  app.value = { plugins: [], trustedOrigins: [] };
}, SLOW);
