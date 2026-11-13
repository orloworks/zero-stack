import { expect, test } from "bun:test";
import { validateFlags } from "../../src/flags";

const base = { tailwind: false, shadcn: false, zodRpc: false, auth: false };

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
    name: "x", framework: "react", tailwind: true, shadcn: false, zodRpc: true, auth: true,
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
