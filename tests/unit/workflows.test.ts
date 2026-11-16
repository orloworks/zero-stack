import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../../.github/workflows");
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

test("there is a release workflow", () => {
  expect(files).toContain("release.yml");
});

test.each(files)("%s triggers only on workflow_dispatch", (f) => {
  const wf = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as { on?: unknown };
  expect(wf.on).toBeDefined();
  const triggers = typeof wf.on === "string" ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on as object);
  expect(triggers).toEqual(["workflow_dispatch"]);
});

type Workflow = { jobs: Record<string, { steps: { run?: string; uses?: string }[] }> };

// Any step that could publish: a `<package manager> publish` command on any line, or a publish action.
const publishSteps = (wf: Workflow): string[] =>
  Object.values(wf.jobs).flatMap((j) => j.steps).flatMap((s) => [s.run ?? "", s.uses ?? ""])
    .filter((x) => /\b(npm|bun|pnpm|yarn|npx|bunx)\b[^\n]*\bpublish\b/i.test(x) || /^[^\s]*publish[^\s]*@/i.test(x));

test.each(files)("%s never publishes", (f) => {
  expect(publishSteps(Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as Workflow)).toEqual([]);
});

test("the publish check catches npm, bun, pnpm, yarn and publish actions", () => {
  const wf = (step: object): Workflow => ({ jobs: { j: { steps: [step] } } });
  for (const step of [
    { run: "npm publish" }, { run: "bun publish --access public" }, { run: "pnpm publish" }, { run: "yarn publish" },
    { run: "bun install\nbun publish" }, { uses: "JS-DevTools/npm-publish@v3" }, { uses: "some/action-publish@v1" },
  ])
    expect(publishSteps(wf(step))).not.toEqual([]);
  expect(publishSteps(wf({ run: "bun run ci:full" }))).toEqual([]);
});
