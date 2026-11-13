#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type FlagInput, validateFlags } from "./flags";
import { clackUi, fillPrompts } from "./prompts";
import { preflight, scaffold } from "./pipeline";

const USAGE =
  "Usage: create-zero-stack <directory> [--framework react|vue|svelte|solid] [--tailwind] [--shadcn] [--zod-rpc] [--auth]";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      framework: { type: "string" },
      tailwind: { type: "boolean" },
      shadcn: { type: "boolean" },
      "zod-rpc": { type: "boolean" },
      auth: { type: "boolean" },
    },
  });
  if (positionals.length > 1) throw new Error(USAGE);
  preflight();
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!positionals.length && !interactive) throw new Error(USAGE);
  let input: Partial<FlagInput> = {
    name: positionals[0] && basename(resolve(positionals[0])),
    framework: values.framework,
    tailwind: values.tailwind,
    shadcn: values.shadcn,
    zodRpc: values["zod-rpc"],
    auth: values.auth,
  };
  // shortcut: bad flags are only reported after the prompts finish; validate-first if that annoys.
  if (interactive) input = await fillPrompts(input, clackUi);
  const { config, notes } = validateFlags(input as FlagInput);
  for (const n of notes) console.log(n);
  const target = positionals[0] ?? config.name;
  await scaffold(config, resolve(target));
  console.log(`\nDone. cd ${target} && bun dev`);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
