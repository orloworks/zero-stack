#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { argv, FEATURE_LIST, type FlagInput, parseFeature, validateFlags } from "./flags";
import { closingLines } from "./closing";
import { clackUi, fillPrompts } from "./prompts";
import { preflight, scaffold } from "./pipeline";
import { upgrade } from "./upgrade";

const USAGE = `Usage: create-zero-stack <directory> [--framework react|vue|svelte|solid] ${FEATURE_LIST.map((f) => `[${argv(f).join(" ")}]`).join(" ")}`;

try {
  // Before parsing and the Node preflight: --help must work anywhere, and parseArgs would reject it as unknown.
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      framework: { type: "string" },
      ...Object.fromEntries(FEATURE_LIST.map((f) => [f.flag, { type: f.value ? ("string" as const) : ("boolean" as const) }])),
    },
  });
  if (positionals.length > 1) throw new Error(USAGE);
  preflight();
  if (positionals[0] === "upgrade") {
    if (Object.keys(values).length) throw new Error("upgrade takes no arguments: run `bunx github:orloworks/zero-stack#v<new> upgrade` in the app.");
    process.exit(await upgrade(process.cwd()));
  }
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!positionals.length && !interactive) throw new Error(USAGE);
  let input: Partial<FlagInput> = {
    name: positionals[0] && basename(resolve(positionals[0])),
    framework: values.framework,
    ...Object.fromEntries(FEATURE_LIST.map((f) => [f.key, parseFeature(f, (values as Record<string, string | boolean | undefined>)[f.flag])])),
  };
  // shortcut: bad flags are only reported after the prompts finish; validate-first if that annoys.
  if (interactive) input = await fillPrompts(input, clackUi);
  const { config, notes } = validateFlags(input as FlagInput);
  for (const n of notes) console.log(n);
  const target = positionals[0] ?? config.name;
  await scaffold(config, resolve(target));
  console.log(`\nDone. cd ${target} && bun dev`);
  for (const line of closingLines(config)) console.log(line);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
