import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../../src/pipeline";

const tmp = () => mkdtempSync(join(tmpdir(), "zs-test-"));
const cfg = { name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false } as const;

test("refuses a non-empty target and writes nothing", async () => {
  const dir = join(tmp(), "app");
  mkdirSync(dir);
  writeFileSync(join(dir, "keep.txt"), "x");
  await expect(scaffold(cfg, dir, async () => { throw new Error("must not run"); })).rejects.toThrow(/not empty/);
  expect(readdirSync(dir)).toEqual(["keep.txt"]);
});

test("a failure after the directory is created leaves no directory behind", async () => {
  const dir = join(tmp(), "app");
  await expect(
    scaffold(cfg, dir, async () => { mkdirSync(dir); throw new Error("boom"); }),
  ).rejects.toThrow(/boom/);
  expect(existsSync(dir)).toBe(false);
});

test("wrong Node version exits 1 with the supported range", () => {
  const bin = tmp();
  writeFileSync(join(bin, "node"), "#!/bin/sh\necho v20.1.0\n");
  chmodSync(join(bin, "node"), 0o755);
  const r = Bun.spawnSync([process.execPath, "src/index.ts", join(tmp(), "app")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("^24.22 || >=26.12");
});

function seeded(agents: string, scripts: object = { postinstall: "void prepare" }) {
  const dir = join(tmp(), "app");
  return {
    dir,
    exec: async (cmd: string[]) => {
      if (cmd[1] !== "x") return;
      mkdirSync(join(dir, "routes/api"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
      writeFileSync(join(dir, "AGENTS.md"), agents);
    },
  };
}

test("adds verify, test, db:reset, the route test and a fenced AGENTS.md line", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  await scaffold(cfg, dir, exec);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  expect(pkg.scripts.verify).toBe("void prepare && vp check && tsc --noEmit && vp build && vp test");
  expect(pkg.scripts["db:reset"]).toBe("void db reset --yes");
  expect(pkg.scripts.test).toBe("vp test");
  expect(existsSync(join(dir, "tests/hello.test.ts"))).toBe(true);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toMatch(/<!-- zero-stack:verify -->[^]*verify[^]*<!-- \/zero-stack:verify -->/);
});

test("a missing AGENTS.md anchor is a hard error and leaves no directory", async () => {
  const { dir, exec } = seeded("no anchor here");
  await expect(scaffold(cfg, dir, exec)).rejects.toThrow(/anchor missing.*create-void@\d/);
  expect(existsSync(dir)).toBe(false);
});

test("--shadcn with a non-React framework exits 1 with the fix and creates nothing", () => {
  const dir = join(tmp(), "app");
  const r = Bun.spawnSync([process.execPath, "src/index.ts", dir, "--framework", "vue", "--shadcn"]);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain(
    "error: --shadcn requires --framework react (got vue); drop --shadcn or use --framework react.",
  );
  expect(existsSync(dir)).toBe(false);
});

test("zodRpc adds zod, the validated route and the typed client sample", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  await scaffold({ ...cfg, zodRpc: true }, dir, exec);
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies.zod).toMatch(/^4\./);
  expect(readFileSync(join(dir, "routes/api/echo.ts"), "utf8")).toContain("withValidator");
  expect(readFileSync(join(dir, "src/rpc.ts"), "utf8")).toContain('"/api/echo"');
});

test("auth merges @auth-schema into existing paths, writes .env, enables auth", async () => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
  };
  await scaffold({ ...cfg, auth: true }, dir, exec);
  const paths = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths;
  expect(Object.keys(paths).sort()).toEqual(["@/*", "@auth-schema"]);
  expect(readFileSync(join(dir, "void.config.ts"), "utf8")).toContain('"auth"');
  expect(readFileSync(join(dir, ".gitignore"), "utf8").split("\n")).toContain(".env");
  expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^BETTER_AUTH_SECRET=\S{40,}\nBETTER_AUTH_URL=http:\/\/localhost:5173\n$/);
  expect(existsSync(join(dir, "pages/sign-in.tsx"))).toBe(true);
});

test("no .env without auth", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  await scaffold(cfg, dir, exec);
  expect(existsSync(join(dir, ".env"))).toBe(false);
});

test("Ctrl-C mid-scaffold removes the target and exits 130", async () => {
  const dir = join(tmp(), "app");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/hang-scaffold.ts"), dir], { stdout: "pipe", stderr: "ignore" });
  const reader = p.stdout.getReader();
  while (!new TextDecoder().decode((await reader.read()).value ?? new Uint8Array()).includes("ready")) {}
  expect(existsSync(dir)).toBe(true);
  p.kill("SIGINT");
  expect(await p.exited).toBe(130);
  expect(existsSync(dir)).toBe(false);
});

test("zod-rpc refuses to overwrite an existing routes/api/echo.ts", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const seed = exec;
  const withEcho = async (cmd: string[]) => { await seed(cmd); if (cmd[1] === "x") writeFileSync(join(dir, "routes/api/echo.ts"), "mine"); };
  await expect(scaffold({ ...cfg, zodRpc: true }, dir, withEcho)).rejects.toThrow(/echo\.ts already exists.*create-void@\d/);
  expect(existsSync(dir)).toBe(false);
});
