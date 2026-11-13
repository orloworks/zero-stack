#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateFlags } from "./flags";
import { preflight, scaffold } from "./pipeline";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { framework: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("Usage: create-zero-stack <directory> [--framework react|vue|svelte|solid]");
  preflight();
  const targetDir = resolve(positionals[0]);
  const config = validateFlags({ name: basename(targetDir), framework: values.framework });
  await scaffold(config, targetDir);
  console.log(`\nDone. cd ${positionals[0]} && bun dev`);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
