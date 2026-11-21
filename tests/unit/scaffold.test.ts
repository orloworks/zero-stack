import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShadcn } from "../../src/installers/shadcn";
import { installZodRpc } from "../../src/installers/zod-rpc";
import { installTailwind } from "../../src/installers/tailwind";
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
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts, dependencies: {} }));
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
  await expect(scaffold(cfg, dir, exec)).rejects.toThrow(/"<!--\/injected-by-void-->" not found in AGENTS\.md \(create-void@\d/);
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

// Shaped like create-void's tsconfig.json: the anchors are `"compilerOptions": {` and, once shadcn ran, `"paths": {`.
const tsconfig = (extra = "") => `{\n"extends": "./.void/tsconfig.json",\n"compilerOptions": {\n${extra ? extra + ",\n" : ""}"jsx": "react-jsx"\n}\n}\n`;

test("auth merges @auth-schema into existing paths, writes .env, enables auth", async () => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig(`"paths": {\n"@/*": ["./src/*"]\n}`));
  };
  await scaffold({ ...cfg, auth: true }, dir, exec);
  const paths = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths;
  expect(Object.keys(paths).sort()).toEqual(["@/*", "@auth-schema"]);
  expect(readFileSync(join(dir, "void.config.ts"), "utf8")).toContain('"auth"');
  expect(readFileSync(join(dir, ".gitignore"), "utf8").split("\n")).toContain(".env");
  expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, ".env"), "utf8")).toMatch(/^BETTER_AUTH_SECRET=\S{40,}\nBETTER_AUTH_URL=http:\/\/localhost:5173\n$/);
  expect(existsSync(join(dir, "pages/sign-in.tsx"))).toBe(true);
});

test("auth without shadcn adds Void's four mappings with @auth-schema, as valid JSON", async () => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  await scaffold({ ...cfg, auth: true }, dir, exec);
  const ts = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
  expect(Object.keys(ts.compilerOptions.paths).sort()).toEqual(["@auth-schema", "@schema", "@schema/*", "void/db", "void/routes"]);
  expect(ts.compilerOptions.jsx).toBe("react-jsx");
});

test("a missing tsconfig anchor is the anchor error naming the file and pin", async () => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
  };
  await expect(scaffold({ ...cfg, auth: true }, dir, exec)).rejects.toThrow(/not found in tsconfig\.json \(create-void@\d/);
});

test("tailwind and shadcn report a missing package.json key as an anchor error, not a TypeError", () => {
  for (const [install, key] of [[installTailwind, "devDependencies"], [installShadcn, "dependencies"]] as const) {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => install(dir)).toThrow(new RegExp(`Anchor "${key}" not found in package\\.json \\(create-void@\\d`));
  }
});

test("no .env without auth", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  await scaffold(cfg, dir, exec);
  expect(existsSync(join(dir, ".env"))).toBe(false);
});

async function hung(sig: "SIGINT" | "SIGTERM") {
  const base = tmp();
  const dir = join(base, "app"), pidfile = join(base, "pid");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/hang-scaffold.ts"), dir, pidfile], { stdout: "pipe", stderr: "ignore" });
  const reader = p.stdout.getReader();
  let out = "";
  const deadline = Date.now() + 10_000;
  while (!out.includes("ready")) {
    const r = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const)]);
    if (r === "timeout" || r.done) { p.kill("SIGKILL"); throw new Error(`helper never printed ready (got ${JSON.stringify(out)})`); }
    out += new TextDecoder().decode(r.value);
  }
  const pid = +readFileSync(pidfile, "utf8");
  expect(existsSync(dir)).toBe(true);
  p.kill(sig);
  const code = await Promise.race([p.exited, Bun.sleep(10_000).then(() => { p.kill("SIGKILL"); return "hung" as const; })]);
  return { code, dir, pid };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50); return !alive(pid); };

test("Ctrl-C mid-scaffold kills the child tree, removes the target and exits 130", async () => {
  const { code, dir, pid } = await hung("SIGINT");
  expect(code).toBe(130);
  expect(existsSync(dir)).toBe(false);
  expect(await gone(pid)).toBe(true);
});

test("SIGTERM mid-scaffold kills the child tree, removes the target and exits 143", async () => {
  const { code, dir, pid } = await hung("SIGTERM");
  expect(code).toBe(143);
  expect(existsSync(dir)).toBe(false);
  expect(await gone(pid)).toBe(true);
});

test("a failed run in an existing empty directory leaves it in place and empty", async () => {
  const dir = join(tmp(), "app");
  mkdirSync(dir);
  await expect(scaffold(cfg, dir, async () => { writeFileSync(join(dir, "junk"), "x"); throw new Error("boom"); })).rejects.toThrow(/boom/);
  expect(readdirSync(dir)).toEqual([]);
});

test("signal handlers are removed after scaffold resolves and after it rejects", async () => {
  const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  const before = count();
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  let during = 0;
  await scaffold(cfg, dir, async (c, cwd) => { during = count(); await exec(c); });
  expect(during).toBeGreaterThan(before);
  expect(count()).toBe(before);
  await expect(scaffold(cfg, join(tmp(), "app"), async () => { throw new Error("boom"); })).rejects.toThrow();
  expect(count()).toBe(before);
});

test("fails clearly when create-void made a different directory than the target", async () => {
  const base = tmp();
  const dir = join(base, "other");
  await expect(scaffold(cfg, dir, async () => { mkdirSync(join(base, "app")); })).rejects.toThrow(/did not produce .*other\/package\.json.*app/);
  expect(existsSync(dir)).toBe(false);
});

test("a pre-existing empty target with no create-void output fails clearly and stays empty", async () => {
  const dir = join(tmp(), "app");
  mkdirSync(dir);
  await expect(scaffold(cfg, dir, async () => {})).rejects.toThrow(/did not produce .*app\/package\.json/);
  expect(readdirSync(dir)).toEqual([]);
});

test("auth tsconfig with an empty compilerOptions stays valid JSON", async () => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": {} }');
  };
  await scaffold({ ...cfg, auth: true }, dir, exec);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).compilerOptions.paths)).toContain("@auth-schema");
});

test("zod-rpc reports a missing dependencies key as an anchor error", () => {
  const dir = tmp();
  mkdirSync(join(dir, "routes/api"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  expect(() => installZodRpc(dir)).toThrow(/Anchor "dependencies" not found in package\.json \(create-void@\d/);
});

test("zod-rpc refuses to overwrite an existing routes/api/echo.ts", async () => {
  const { dir, exec } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const seed = exec;
  const withEcho = async (cmd: string[]) => { await seed(cmd); if (cmd[1] === "x") writeFileSync(join(dir, "routes/api/echo.ts"), "mine"); };
  await expect(scaffold({ ...cfg, zodRpc: true }, dir, withEcho)).rejects.toThrow(/echo\.ts" already exists.*create-void@\d/);
  expect(existsSync(dir)).toBe(false);
});

const authApp = (framework: "react" | "vue" | "svelte" | "solid") => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  return { dir, run: () => scaffold({ ...cfg, framework, auth: true }, dir, exec) };
};

test("react, vue and solid --auth keep v0.1 output: sign-in/up only, no auth.ts, no Account note", async () => {
  const want: Record<string, string[]> = { react: ["sign-in.tsx", "sign-up.tsx"], vue: ["sign-in.vue", "sign-up.vue"], solid: ["sign-in.tsx", "sign-up.tsx"] };
  for (const fw of ["react", "vue", "solid"] as const) {
    const { dir, run } = authApp(fw);
    await run();
    expect(readdirSync(join(dir, "pages")).sort()).toEqual(want[fw]!);
    for (const f of want[fw]!)
      expect(readFileSync(join(dir, "pages", f), "utf8")).toBe(readFileSync(join(import.meta.dir, "../../template/auth", fw, "pages", f), "utf8"));
    expect(existsSync(join(dir, "auth.ts"))).toBe(false);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toContain("/settings");
  }
});

test("svelte --auth ships /settings with its loader, a plain composed auth.ts and the AGENTS.md note", async () => {
  const { dir, run } = authApp("svelte");
  await run();
  expect(readdirSync(join(dir, "pages")).sort()).toEqual(["settings.server.ts", "settings.svelte", "sign-in.svelte", "sign-up.svelte"]);
  expect(readFileSync(join(dir, "auth.ts"), "utf8")).toBe(
    'import { defineAuth } from "void/auth";\n\nexport default defineAuth(({ defaults }) => ({\n  ...defaults,\n}));\n',
  );
  expect(readFileSync(join(dir, "pages/settings.svelte"), "utf8")).toContain("<!-- zero-stack:account-deletion -->");
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("`/settings`");
});

test("svelte --account-deletion adds the Delete account section, deleteUser in auth.ts and the AGENTS.md rules; absent without the flag", async () => {
  const off = authApp("svelte");
  await off.run();
  expect(readFileSync(join(off.dir, "pages/settings.svelte"), "utf8")).not.toContain("Delete account");
  expect(readFileSync(join(off.dir, "auth.ts"), "utf8")).not.toContain("deleteUser");
  expect(readFileSync(join(off.dir, "AGENTS.md"), "utf8")).not.toContain("onDelete");

  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  await scaffold({ ...cfg, framework: "svelte", auth: true, accountDeletion: true }, dir, exec);
  const page = readFileSync(join(dir, "pages/settings.svelte"), "utf8");
  for (const s of ["Delete account permanently", "It can't be undone.", "Incorrect password.", "Account deleted", "Back to home", "Deleting account…"])
    expect(page).toContain(s);
  expect(page).not.toContain("uploaded files");
  expect(page).not.toContain("zero-stack:account-deletion");
  const authTs = readFileSync(join(dir, "auth.ts"), "utf8");
  expect(authTs).toContain("deleteUser: { enabled: true }");
  for (const s of ['import { APIError, createAuthMiddleware } from "better-auth/api";', 'ctx.path === "/delete-user"', 'new APIError("BAD_REQUEST"']) expect(authTs).toContain(s);
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(agents).toContain('onDelete: "cascade"');
  expect(agents).toContain("social-only");
});

test("svelte sign-in/up keep the D28 contract and carry one anchor per later add-on part", async () => {
  const { dir, run } = authApp("svelte");
  await run();
  const read = (f: string) => readFileSync(join(dir, "pages", f), "utf8");
  const count = (s: string, m: string) => s.split(`<!-- zero-stack:${m} -->`).length - 1;
  const [inn, up] = [read("sign-in.svelte"), read("sign-up.svelte")];
  for (const m of ["sign-in-notice", "sign-in-forgot-link", "turnstile"]) expect(count(inn, m)).toBe(1);
  expect(count(up, "turnstile")).toBe(1);
  expect(inn.indexOf("sign-in-forgot-link")).toBeGreaterThan(inn.indexOf('id="password"'));
  expect(inn.indexOf("zero-stack:turnstile")).toBeLessThan(inn.indexOf('type="submit"'));
  for (const [s, fail, busy] of [[inn, "Sign in failed", "Signing in…"], [up, "Sign up failed", "Creating account…"]] as const) {
    for (const t of ['location.href = "/"', fail, busy, 'role="alert"', "Something went wrong. Check your connection and try again."]) expect(s).toContain(t);
    expect(s).not.toContain("placeholder");
  }
  expect(up).toContain('minlength="8"');
  expect(inn).toContain('href="/sign-up"');
  expect(up).toContain('href="/sign-in"');
});

test("svelte --email adds forgot/reset pages, sign-in edits, send() in auth.ts, the harness test and the AGENTS.md note; absent without the flag", async () => {
  const off = authApp("svelte");
  await off.run();
  expect(readdirSync(join(off.dir, "pages"))).not.toContain("forgot-password.svelte");
  expect(readFileSync(join(off.dir, "auth.ts"), "utf8")).not.toContain("sendResetPassword");
  expect(readFileSync(join(off.dir, "AGENTS.md"), "utf8")).not.toContain("mail domain");

  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  await scaffold({ ...cfg, framework: "svelte", auth: true, email: true }, dir, exec);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  expect(readdirSync(join(dir, "pages"))).toEqual(expect.arrayContaining(["forgot-password.svelte", "reset-password.svelte"]));
  const forgot = read("pages/forgot-password.svelte");
  for (const t of ["requestPasswordReset", 'redirectTo: "/reset-password"', "If an account exists for that email", "Couldn't send the reset link. Try again.", "Sending link…", "Back to sign in"]) expect(forgot).toContain(t);
  expect(forgot.indexOf("<!-- zero-stack:turnstile -->")).toBeLessThan(forgot.indexOf('type="submit"'));
  const reset = read("pages/reset-password.svelte");
  for (const t of ["history.replaceState", 'content="no-referrer"', "INVALID_TOKEN", "This reset link has expired or was already used.", "Request a new link", "Choose a new password", "/sign-in?reset=1"]) expect(reset).toContain(t);
  const inn = read("pages/sign-in.svelte");
  for (const t of ["Forgot password?", "Password updated. Sign in with your new password."]) expect(inn).toContain(t);
  expect(inn).not.toMatch(/zero-stack:sign-in-(notice|forgot-link)/);
  expect(inn).toContain("<!-- zero-stack:turnstile -->");
  const auth = read("auth.ts");
  for (const t of ["sendResetPassword", "sendVerificationEmail", "sendOnSignUp: true", "revokeSessionsOnPasswordReset: true", 'from "./src/mail"']) expect(auth).toContain(t);
  for (const t of ["result.deliveries", "result.error", "console.error", "throw new Error"]) expect(read("src/mail.ts")).toContain(t);
  expect(auth).not.toContain("requireEmailVerification");
  expect(read("tests/auth-email.test.ts")).toContain("createEmailTestHarness");
  expect(read("AGENTS.md")).toContain("mail domain");
});

test("svelte --turnstile wires captcha in auth.ts, the helper, the guard, widget pages, the test secret and the AGENTS.md note; absent without the flag", async () => {
  const off = authApp("svelte");
  await off.run();
  expect(readFileSync(join(off.dir, "auth.ts"), "utf8")).not.toContain("captcha");
  expect(existsSync(join(off.dir, "src/lib/turnstile.ts"))).toBe(false);

  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  await scaffold({ ...cfg, framework: "svelte", auth: true, email: true, turnstile: true }, dir, exec);
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const auth = read("auth.ts");
  for (const t of ['from "better-auth/plugins"', 'provider: "cloudflare-turnstile"', "turnstileSecret(env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_URL)", "{ defaults, env }"]) expect(auth).toContain(t);
  expect(read("env.ts")).toContain('VITE_TURNSTILE_SITE_KEY: string().default("1x00000000000000000000AA")');
  expect(read(".env")).toContain("TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA");
  for (const f of ["src/lib/turnstile.ts", "src/turnstile-guard.ts", "tests/turnstile.test.ts", "tests/turnstile-guard.test.ts"]) expect(existsSync(join(dir, f))).toBe(true);
  for (const page of ["sign-in", "sign-up", "forgot-password"]) {
    const p = read(`pages/${page}.svelte`);
    expect(p).not.toContain("zero-stack:turnstile");
    for (const t of ["mountTurnstile", "x-captcha-response", "turnstile?.reset()", "t.dispose()", "Completing a quick check…", "Couldn't load the verification check. Reload the page to try again.", "disabled={pending || !token}"]) expect(p).toContain(t);
    expect(p.indexOf("bind:this={turnstileEl}")).toBeLessThan(p.indexOf('type="submit"'));
  }
  expect(read("AGENTS.md")).toContain("void secret put TURNSTILE_SECRET_KEY");
});

const storageApp = (config: Record<string, unknown>) => {
  const { dir, exec: seed } = seeded("<!--injected-by-void-v1-->\n<!--/injected-by-void-->\n");
  const exec = async (cmd: string[]) => {
    await seed(cmd);
    if (cmd[1] !== "x") return;
    writeFileSync(join(dir, "void.config.ts"), "export default defineConfig({\n});\n");
    writeFileSync(join(dir, "tsconfig.json"), tsconfig());
  };
  return { dir, run: () => scaffold({ ...cfg, ...config } as any, dir, exec) };
};

test("--storage with --auth adds requireAuth routes on any framework and leaves the pages alone", async () => {
  for (const framework of ["react", "vue", "solid"] as const) {
    const { dir, run } = storageApp({ framework, auth: true, storage: true });
    await run();
    const route = readFileSync(join(dir, "routes/api/files/[name].ts"), "utf8");
    expect(route.match(/requireAuth\(c\)/g)).toHaveLength(3);
    for (const m of ["PUT", "GET", "DELETE"]) expect(route).toContain(`export const ${m} =`);
    expect(existsSync(join(dir, "auth.ts"))).toBe(false);
    expect(readdirSync(join(dir, "pages")).sort()).toEqual(readdirSync(join(import.meta.dir, "../../template/auth", framework, "pages")).sort());
  }
});

test("svelte --storage --account-deletion purges before and after deletion and mentions uploaded files; neither without --storage", async () => {
  const on = storageApp({ framework: "svelte", auth: true, accountDeletion: true, storage: true });
  await on.run();
  const auth = readFileSync(join(on.dir, "auth.ts"), "utf8");
  for (const t of ['import { purgeUserFiles } from "./src/storage"', "beforeDelete:", "afterDelete:", 'code: "STORAGE_PURGE_FAILED"']) expect(auth).toContain(t);
  expect(auth.match(/user: \{/g)).toHaveLength(1);
  const agents = readFileSync(join(on.dir, "AGENTS.md"), "utf8");
  expect(agents).toContain("purges a user's files. `routes/api/files/[name].ts`");
  expect(agents).toContain("so account deletion can purge it. Deleting an account first");
  const page = readFileSync(join(on.dir, "pages/settings.svelte"), "utf8");
  for (const t of ["all its data and uploaded files.", "data and uploaded files have been", 'code === "STORAGE_PURGE_FAILED"', "Your account was not deleted, but some of your files may already have been removed. Try again to finish deleting your account."])
    expect(page).toContain(t);

  const off = storageApp({ framework: "svelte", auth: true, accountDeletion: true });
  await off.run();
  expect(readFileSync(join(off.dir, "auth.ts"), "utf8")).not.toMatch(/purgeUserFiles|beforeDelete/);
  const offPage = readFileSync(join(off.dir, "pages/settings.svelte"), "utf8");
  expect(offPage).not.toMatch(/uploaded files|STORAGE_PURGE_FAILED/);
  expect(existsSync(join(off.dir, "src/storage.ts"))).toBe(false);
});

// create-void's tsconfig.json (svelte, 1.8.0): `include` lists directories, not scripts/.
const REAL_TSCONFIG = JSON.stringify({ extends: "./.void/tsconfig.json", compilerOptions: { strict: true }, include: ["src", "pages", "routes", "middleware", "crons", "queues", "db"] }, null, 2);
const withTsconfig = (s: ReturnType<typeof seeded>, body = REAL_TSCONFIG) => async (cmd: string[]) => {
  await s.exec(cmd);
  if (cmd[1] === "x") writeFileSync(join(s.dir, "tsconfig.json"), body);
};

test("secrets adds scripts/secrets.ts, the secrets:pull script and the .env.pull-tmp ignore; without it, none of them", async () => {
  const on = seeded("<!--/injected-by-void-->\n");
  await scaffold({ ...cfg, secrets: true }, on.dir, withTsconfig(on));
  expect(JSON.parse(readFileSync(join(on.dir, "package.json"), "utf8")).scripts["secrets:pull"]).toBe("node scripts/secrets.ts pull");
  expect(JSON.parse(readFileSync(join(on.dir, "package.json"), "utf8")).scripts["secrets:push"]).toBe("node scripts/secrets.ts push");
  expect(existsSync(join(on.dir, "scripts/secrets.ts"))).toBe(true);
  expect(readFileSync(join(on.dir, ".gitignore"), "utf8").split("\n")).toContain(".env.pull-tmp");
  expect(JSON.parse(readFileSync(join(on.dir, "tsconfig.json"), "utf8")).include).toEqual(["src", "pages", "routes", "middleware", "crons", "queues", "db", "scripts"]);
  const off = seeded("<!--/injected-by-void-->\n");
  await scaffold(cfg, off.dir, withTsconfig(off));
  expect(JSON.parse(readFileSync(join(off.dir, "package.json"), "utf8")).scripts["secrets:pull"]).toBeUndefined();
  expect(JSON.parse(readFileSync(join(off.dir, "package.json"), "utf8")).scripts["secrets:push"]).toBeUndefined();
  expect(existsSync(join(off.dir, "scripts/secrets.ts"))).toBe(false);
  expect(JSON.parse(readFileSync(join(off.dir, "tsconfig.json"), "utf8")).include).not.toContain("scripts");
});

test("secrets with a tsconfig that has no include is the anchor error", async () => {
  const on = seeded("<!--/injected-by-void-->\n");
  await expect(scaffold({ ...cfg, secrets: true }, on.dir, withTsconfig(on, "{}"))).rejects.toThrow(/Anchor "include" not found in tsconfig\.json \(create-void@\d/);
});
