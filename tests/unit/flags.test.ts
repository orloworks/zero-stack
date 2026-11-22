import { expect, test } from "bun:test";
import { argv, FEATURE_LIST, parseFeature, validateFlags } from "../../src/flags";

const base = { admin: false, inviteOnly: false, tailwind: false, shadcn: false, zodRpc: false, auth: false, accountDeletion: false, email: false, turnstile: false, storage: false, secrets: false };

test("defaults: react, every installer off, no notes", () => {
  expect(validateFlags({ name: "my-app" })).toEqual({
    config: { name: "my-app", framework: "react", ...base },
    notes: [],
  });
});

test("every framework is accepted", () => {
  for (const framework of ["react", "vue", "svelte", "solid"])
    expect(validateFlags({ name: "x", framework }).config.framework as string).toBe(framework);
});

test("installer flags are recorded", () => {
  expect(validateFlags({ name: "x", tailwind: true, zodRpc: true, auth: true }).config).toEqual({
    name: "x", framework: "react", ...base, tailwind: true, zodRpc: true, auth: true,
  });
});

test("--shadcn implies --tailwind and says so", () => {
  const r = validateFlags({ name: "x", shadcn: true });
  expect(r.config).toMatchObject({ shadcn: true, tailwind: true });
  expect(r.notes).toEqual(["--shadcn implies --tailwind; enabling Tailwind."]);
});

test("--shadcn with --tailwind says nothing", () => {
  expect(validateFlags({ name: "x", shadcn: true, tailwind: true }).notes).toEqual([]);
});

test("--tailwind works on every framework", () => {
  for (const framework of ["vue", "svelte", "solid"])
    expect(validateFlags({ name: "x", framework, tailwind: true }).config.tailwind).toBe(true);
});

test("--shadcn on a non-React framework fails fast with the fix", () => {
  for (const framework of ["vue", "svelte", "solid"])
    expect(() => validateFlags({ name: "x", framework, shadcn: true })).toThrow(
      `--shadcn requires --framework react (got ${framework}); drop --shadcn or use --framework react.`,
    );
});

test("rejects bad names with exact messages", () => {
  expect(() => validateFlags({ name: "My_App" })).toThrow('Name "My_App" must be lowercase a-z, 0-9 and "-" only.');
  expect(() => validateFlags({ name: "" })).toThrow('Name "" must be lowercase a-z, 0-9 and "-" only.');
  expect(() => validateFlags({ name: "a".repeat(64) })).toThrow("Name must be 63 characters or fewer (got 64).");
  expect(validateFlags({ name: "a".repeat(63) }).config.name).toHaveLength(63);
});

test("rejects an unknown framework", () => {
  expect(() => validateFlags({ name: "x", framework: "angular" })).toThrow(
    "--framework must be one of: react, vue, svelte, solid.",
  );
});

test("svelte-only add-ons imply auth and say so", () => {
  const r = validateFlags({ name: "x", framework: "svelte", email: true });
  expect(r.config).toMatchObject({ email: true, auth: true });
  expect(r.notes).toEqual(["--email implies --auth; enabling auth."]);
  expect(validateFlags({ name: "x", framework: "svelte", email: true, auth: true }).notes).toEqual([]);
});

test("svelte-only add-ons are rejected on other frameworks, naming svelte", () => {
  for (const [flag, key] of [["account-deletion", "accountDeletion"], ["email", "email"], ["turnstile", "turnstile"], ["invite-only", "inviteOnly"]])
    for (const framework of ["react", "vue", "solid"])
      expect(() => validateFlags({ name: "x", framework, [key]: true })).toThrow(
        `--${flag} requires --framework svelte (got ${framework}); drop --${flag} or use --framework svelte.`,
      );
});

test("--storage is accepted with any framework and implies auth", () => {
  for (const framework of ["react", "vue", "svelte", "solid"])
    expect(validateFlags({ name: "x", framework, storage: true }).config).toMatchObject({ storage: true, auth: true });
});

test("every feature has a unique flag and key", () => {
  expect(new Set(FEATURE_LIST.map((f) => f.flag)).size).toBe(FEATURE_LIST.length);
  expect(new Set(FEATURE_LIST.map((f) => f.key)).size).toBe(FEATURE_LIST.length);
});

test("--secrets is accepted with any framework and implies auth, saying so", () => {
  for (const framework of ["react", "vue", "svelte", "solid"]) {
    const r = validateFlags({ name: "x", framework, secrets: true });
    expect(r.config).toMatchObject({ secrets: true, auth: true });
    expect(r.notes).toEqual(["--secrets implies --auth; enabling auth."]);
  }
});

const secrets = FEATURE_LIST.find((f) => f.flag === "secrets")!;
const rawArgs = (...a: string[]) => Bun.spawnSync([process.execPath, "src/index.ts", ...a]);

test("argv() derives the valued flag from the table", () => {
  expect(argv(secrets)).toEqual(["--secrets", "infisical"]);
  expect(argv(FEATURE_LIST.find((f) => f.flag === "auth")!)).toEqual(["--auth"]);
});

test("a valued feature accepts only its value", () => {
  expect(parseFeature(secrets, "infisical")).toBe(true);
  expect(parseFeature(secrets, undefined)).toBeUndefined();
  expect(() => parseFeature(secrets, "vault")).toThrow('--secrets accepts only "infisical" (got "vault").');
  expect(parseFeature(FEATURE_LIST.find((f) => f.flag === "auth")!, true)).toBe(true);
});

test("the CLI rejects --secrets vault and a bare --secrets before doing anything", () => {
  const vault = rawArgs("/nonexistent/zs-app", "--secrets", "vault");
  expect(vault.exitCode).toBe(1);
  expect(vault.stderr.toString()).toContain('--secrets accepts only "infisical" (got "vault").');
  const bare = rawArgs("/nonexistent/zs-app", "--secrets");
  expect(bare.exitCode).toBe(1);
  expect(bare.stderr.toString()).toContain("--secrets <value>' argument missing");
});

test("usage text shows the valued flag from argv()", () => {
  const r = rawArgs("a", "b");
  expect(r.stderr.toString()).toContain("[--secrets infisical]");
});

test("--invite-only implies email and, through it, auth, saying so, and is prompted", () => {
  const r = validateFlags({ name: "x", framework: "svelte", inviteOnly: true });
  expect(r.config).toMatchObject({ inviteOnly: true, email: true, auth: true });
  expect(r.notes).toEqual(["--invite-only implies --email; enabling email.", "--email implies --auth; enabling auth."]);
  expect(validateFlags({ name: "x", framework: "svelte", inviteOnly: true, email: true, auth: true }).notes).toEqual([]);
  expect(FEATURE_LIST.find((f) => f.flag === "invite-only")).toMatchObject({ key: "inviteOnly", requires: "email", prompt: "Restrict sign-up to invited emails?" });
});

test("--admin implies email and, through it, auth, saying so; it is one table row and is prompted", () => {
  const r = validateFlags({ name: "x", framework: "svelte", admin: true });
  expect(r.config).toMatchObject({ admin: true, email: true, auth: true });
  expect(r.notes).toEqual(["--admin implies --email; enabling email.", "--email implies --auth; enabling auth."]);
  expect(validateFlags({ name: "x", framework: "svelte", admin: true, email: true, auth: true }).notes).toEqual([]);
  expect(FEATURE_LIST.filter((f) => f.flag === "admin")).toEqual([
    { flag: "admin", key: "admin", label: "admin area", prompt: "Add an admin area?", requires: "email", frameworks: ["svelte"] },
  ]);
});

test("--admin is refused on react, vue and solid, naming svelte", () => {
  for (const framework of ["react", "vue", "solid"])
    expect(() => validateFlags({ name: "x", framework, admin: true })).toThrow(
      `--admin requires --framework svelte (got ${framework}); drop --admin or use --framework svelte.`,
    );
});
