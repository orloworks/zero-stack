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
  return { asked, ui: { text: get, confirm: get } as Ui };
};

const yesAll = { "Project name": "my-app", "Add Tailwind?": true, "Add shadcn/ui?": true, "Add typed zod RPC?": true, "Add auth?": true };

test("interactive and flag-only runs produce identical configs", async () => {
  const t = ui(yesAll);
  const filled = await fillPrompts({ framework: "react" }, t.ui);
  expect(validateFlags(filled).config).toEqual(
    validateFlags({ name: "my-app", framework: "react", tailwind: true, shadcn: true, zodRpc: true, auth: true }).config,
  );
});

test("a declined prompt equals an omitted flag", async () => {
  const t = ui({ ...yesAll, "Add Tailwind?": false, "Add shadcn/ui?": false, "Add typed zod RPC?": false, "Add auth?": false });
  expect(validateFlags(await fillPrompts({}, t.ui)).config).toEqual(validateFlags({ name: "my-app" }).config);
});

test("flags already given are never asked", async () => {
  const t = ui(yesAll);
  await fillPrompts({ name: "x", tailwind: true, auth: true }, t.ui);
  expect(t.asked).toEqual(["Add shadcn/ui?", "Add typed zod RPC?"]);
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
