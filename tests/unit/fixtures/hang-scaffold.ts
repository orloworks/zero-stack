// Runs scaffold with a real tracked child (a shell that backgrounds `sleep` and records its pid); the test
// signals this process and checks that the whole tree and the target directory are gone.
// usage: hang-scaffold.ts <dir> <pidfile>
import { mkdirSync } from "node:fs";
import { run, scaffold } from "../../../src/pipeline";

const [dir, pidfile] = process.argv.slice(2) as [string, string];
const cfg = { name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false } as const;
await scaffold(cfg, dir, async (_cmd, cwd) => {
  mkdirSync(dir);
  await run(["sh", "-c", `sleep 60 & echo $! > '${pidfile}'; echo ready; wait`], cwd);
});
