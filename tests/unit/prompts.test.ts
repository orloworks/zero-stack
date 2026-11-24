import { expect, test } from "bun:test";
import { validateFlags } from "../../src/flags";
import { fillPrompts, type Ui } from "../../src/prompts";

// Scripted answers keyed by prompt message; records what was asked.
const ui = (answers: Record<string, string | boolean>) => {
  const asked: string[] = [];
  const get = async (m: string) => {
    asked.push(m);
    return answers[m];
  };
  return { asked, ui: { text: get, confirm: get, select: get } as Ui };
};

const yesAll = { "Project name": "my-app", Framework: "svelte", "Add Tailwind?": true, "Add shadcn/ui?": true, "Add typed zod RPC?": true, "Add auth?": true, "Add account deletion?": true, "Add email?": true, "Add Turnstile?": true, "Restrict sign-up to invited emails?": true, "Add an admin area?": true, "Add storage?": true, "Sync secrets with Infisical?": true };

test("interactive and flag-only runs produce identical configs", async () => {
  const t = ui(yesAll);
  const filled = await fillPrompts({ framework: "react" }, t.ui);
  expect(validateFlags(filled).config).toEqual(
    validateFlags({ name: "my-app", framework: "react", tailwind: true, shadcn: true, zodRpc: true, auth: true, storage: true, secrets: true }).config,
  );
});

test("a declined prompt equals an omitted flag", async () => {
  const t = ui({ ...yesAll, "Add Tailwind?": false, "Add shadcn/ui?": false, "Add typed zod RPC?": false, "Add auth?": false });
  expect(validateFlags(await fillPrompts({}, t.ui)).config).toEqual(validateFlags({ name: "my-app", framework: "svelte" }).config);
});

test("flags already given are never asked", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "react", tailwind: true, auth: true }, t.ui);
  expect(t.asked).toEqual(["Add shadcn/ui?", "Add typed zod RPC?", "Add storage?", "Sync secrets with Infisical?"]);
});

test("shadcn is not offered for a non-React framework", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "vue" }, t.ui);
  expect(t.asked).not.toContain("Add shadcn/ui?");
});

test("shadcn flag skips the tailwind prompt", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", shadcn: true }, t.ui);
  expect(t.asked).not.toContain("Add Tailwind?");
});

test("add-ons are asked only after auth is yes, and only those valid for the framework", async () => {
  const no = ui({ ...yesAll, "Add auth?": false });
  await fillPrompts({ name: "x", framework: "svelte" }, no.ui);
  expect(no.asked).not.toContain("Add email?");
  expect(no.asked).not.toContain("Add storage?");
  expect(no.asked).not.toContain("Sync secrets with Infisical?");
  const yes = ui(yesAll);
  await fillPrompts({ name: "x", framework: "svelte" }, yes.ui);
  expect(yes.asked.slice(-8)).toEqual(["Add account deletion?", "Add email?", "Add Turnstile?", "Restrict sign-up to invited emails?", "Add an admin area?", "Add Stripe payments?", "Add storage?", "Sync secrets with Infisical?"]);
  const vue = ui(yesAll);
  await fillPrompts({ name: "x", framework: "vue" }, vue.ui);
  expect(vue.asked.slice(-2)).toEqual(["Add storage?", "Sync secrets with Infisical?"]);
  expect(vue.asked).not.toContain("Add email?");
});

test("an add-on flag implies auth, so auth is not asked", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "svelte", email: true }, t.ui);
  expect(t.asked).not.toContain("Add auth?");
  expect(t.asked).not.toContain("Add email?");
  expect(t.asked.slice(-7)).toEqual(["Add account deletion?", "Add Turnstile?", "Restrict sign-up to invited emails?", "Add an admin area?", "Add Stripe payments?", "Add storage?", "Sync secrets with Infisical?"]);
});

test("shadcn is asked even when Tailwind was declined, and choosing it implies Tailwind", async () => {
  const t = ui({ ...yesAll, "Add Tailwind?": false });
  const config = validateFlags(await fillPrompts({ name: "x", framework: "react" }, t.ui)).config;
  expect(t.asked).toContain("Add shadcn/ui?");
  expect(config).toMatchObject({ shadcn: true, tailwind: true });
});

test("implication is followed transitively: invite-only implies email implies auth", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "svelte", inviteOnly: true }, t.ui);
  for (const q of ["Add auth?", "Add email?", "Restrict sign-up to invited emails?"]) expect(t.asked).not.toContain(q);
  const no = ui({ ...yesAll, "Add auth?": false });
  const out = await fillPrompts({ name: "x", framework: "svelte" }, no.ui);
  expect(no.asked).not.toContain("Restrict sign-up to invited emails?");
  expect(validateFlags(out).config.inviteOnly).toBe(false);
});

test("--admin is prompted like the other add-ons, skipped when implied or off-framework", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "svelte", admin: true }, t.ui);
  for (const q of ["Add auth?", "Add email?", "Add an admin area?"]) expect(t.asked).not.toContain(q);
  const react = ui(yesAll);
  await fillPrompts({ name: "x", framework: "react" }, react.ui);
  expect(react.asked).not.toContain("Add an admin area?");
});

test("no framework flag asks for the framework, then the svelte-only questions", async () => {
  const t = ui(yesAll);
  const out = await fillPrompts({ name: "x" }, t.ui);
  expect(out.framework).toBe("svelte");
  for (const q of ["Add account deletion?", "Add email?", "Add Turnstile?", "Restrict sign-up to invited emails?", "Add an admin area?"]) expect(t.asked).toContain(q);
});

test("a framework flag skips the framework question", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", framework: "react" }, t.ui);
  expect(t.asked).not.toContain("Framework");
});

test("the framework is asked before any feature question", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x" }, t.ui);
  expect(t.asked[0]).toBe("Framework");
});
