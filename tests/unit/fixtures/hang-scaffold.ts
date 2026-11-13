// Calls scaffold with an exec that creates the target then hangs; the test sends it SIGINT.
import { mkdirSync } from "node:fs";
import { scaffold } from "../../../src/pipeline";

const dir = process.argv[2]!;
const cfg = { name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false } as const;
await scaffold(cfg, dir, async () => { mkdirSync(dir); console.log("ready"); await new Promise(() => setInterval(() => {}, 1000)); });
