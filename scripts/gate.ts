// Scaffold into a temp dir, then vp check/build/test, verify, db:reset, GET / against vp dev.
// Optional args choose the permutation: bun scripts/gate.ts [--framework vue] [--tailwind] [--shadcn] [--zod-rpc] [--auth]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFlags } from "../src/flags";
import { preflight, scaffold } from "../src/pipeline";

const root = mkdtempSync(join(tmpdir(), "zs-gate-"));
const app = join(root, "gate-app");
const vp = join(app, "node_modules/.bin/vp");
let dev: ReturnType<typeof Bun.spawn> | undefined;

const stopDev = () => {
  // detached => own process group; kill the whole group so no vite/workerd child survives.
  if (dev?.pid) try { process.kill(-dev.pid, "SIGTERM"); } catch {}
};
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { stopDev(); process.exit(130); });

async function step(args: string[]) {
  const p = Bun.spawn([vp, ...args], { cwd: app, stdio: ["ignore", "inherit", "inherit"] });
  if ((await p.exited) !== 0) throw new Error(`vp ${args.join(" ")} failed`);
}

try {
  preflight();
  const argv = process.argv.slice(2);
  const fw = argv.indexOf("--framework");
  const input = {
    name: "gate-app",
    framework: fw >= 0 ? argv[fw + 1] : undefined,
    tailwind: argv.includes("--tailwind") || undefined,
    shadcn: argv.includes("--shadcn") || undefined,
    zodRpc: argv.includes("--zod-rpc") || undefined,
    auth: argv.includes("--auth") || undefined,
  };
  await scaffold(validateFlags(input).config, app);
  await step(["check"]);
  await step(["build"]);
  await step(["test"]);
  for (const script of ["verify", "db:reset"]) {
    const p = Bun.spawn([process.execPath, "run", script], { cwd: app, stdio: ["ignore", "inherit", "inherit"] });
    if ((await p.exited) !== 0) throw new Error(`bun run ${script} failed`);
  }

  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  dev = Bun.spawn([vp, "dev", "--port", String(port), "--strictPort"], {
    cwd: app, stdio: ["ignore", "inherit", "inherit"], detached: true,
  });
  let status = 0;
  for (let i = 0; i < 120 && status !== 200; i++) {
    await Bun.sleep(500);
    if (dev.exitCode !== null) throw new Error("vp dev exited early");
    status = await fetch(`http://localhost:${port}/`).then((r) => r.status, () => 0);
  }
  if (status !== 200) throw new Error(`GET / returned ${status}`);
  console.log(`gate: GET / -> ${status}`);
} catch (e) {
  console.error(`gate failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  stopDev();
  rmSync(root, { recursive: true, force: true });
}
