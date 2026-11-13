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
