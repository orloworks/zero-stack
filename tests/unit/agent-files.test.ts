import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkSkill } from "../../scripts/link-skill";
import { scaffold } from "../../src/pipeline";
import { tmpMaker } from "./tmp";
const mkTmp = tmpMaker();

const tmp = () => mkTmp("zs-test-");
const OPEN = "<!-- zero-stack:routing -->";

// Fake create-void: makes the dir with Void's AGENTS.md and a package.json.
const fake = (dir: string) => async (cmd: string[]) => {
  if (cmd.some((c) => c.startsWith("create-void@"))) {
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { postinstall: "void prepare" } }));
    writeFileSync(join(dir, "AGENTS.md"), "# Void\nvoid section\n<!--/injected-by-void-->\n");
    writeFileSync(join(dir, "tsconfig.json"), '{"include":["src"]}');
  }
};

test("scaffold appends one routing block to AGENTS.md and writes .mcp.json", async () => {
  const dir = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, dir, fake(dir));
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(agents.startsWith("# Void\nvoid section\n<!--/injected-by-void-->\n")).toBe(true);
  expect(agents.split(OPEN).length).toBe(2);
  expect(agents).toContain("migrate-vite-cloudflare-to-void");
  expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers["cloudflare-docs"].url).toBe(
    "https://docs.mcp.cloudflare.com/mcp",
  );
});

test(".mcp.json adds the Svelte MCP server for svelte apps only", async () => {
  const mcp = async (framework: "svelte" | "react") => {
    const dir = join(tmp(), "app");
    await scaffold({ name: "app", framework, tailwind: false, shadcn: false, zodRpc: false, auth: false }, dir, fake(dir));
    return JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers;
  };
  expect((await mcp("svelte")).svelte).toEqual({ type: "http", url: "https://mcp.svelte.dev/mcp" });
  expect((await mcp("react")).svelte).toBeUndefined();
});

test("re-running replaces the block in place and keeps surrounding text", async () => {
  const dir = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, dir, fake(dir));
  const f = join(dir, "AGENTS.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("void section", "void section edited") + "\ntail\n");
  const { writeAgentFiles } = await import("../../src/agent-files");
  writeAgentFiles(dir);
  const out = readFileSync(f, "utf8");
  expect(out.split(OPEN).length).toBe(2);
  expect(out).toContain("void section edited");
  expect(out).toContain("\ntail\n");
});

test("link-skill symlinks into the given dir and is idempotent", () => {
  const dir = join(tmp(), "skill");
  linkSkill(dir);
  linkSkill(dir);
  for (const n of ["SKILL.md", "routing.md"]) expect(lstatSync(join(dir, n)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(dir, "routing.md"))).toMatch(/docs\/cloudflare-routing\.md$/);
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("Containers");
});

test("--secrets adds an AGENTS.md section on linking, what pull does and what it refuses", async () => {
  const on = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false, secrets: true }, on, fake(on));
  const agents = readFileSync(join(on, "AGENTS.md"), "utf8");
  expect(agents).toContain("## Secrets");
  for (const s of ["secret-sync", "infisical init --project-id", "bun run secrets:pull", ".infisical.yaml", "lacks any key"])
    expect(agents).toContain(s);
  const off = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false }, off, fake(off));
  expect(readFileSync(join(off, "AGENTS.md"), "utf8")).not.toContain("## Secrets");
});

test("--secrets AGENTS.md documents push as a one-time seed, the naming convention and the production route", async () => {
  const on = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false, secrets: true }, on, fake(on));
  const agents = readFileSync(join(on, "AGENTS.md"), "utf8");
  for (const s of [
    "bun run secrets:push", "one-time seed", "overwrites", "some keys may already have been set",
    "^[A-Z][A-Z0-9_]*$", "__VOID_", "_PREVIOUS", "env.ts",
    "umask 077", "mktemp", "trap 'rm -f \"$raw\" \"$f\"' EXIT; trap 'exit 1' INT TERM HUP", "Infisical rejects empty values",
    "```bash\n(\n  umask 077",
    ">| \"$raw\" || exit 1\n", "  raw= f=\n  trap", "`command grep -a`",
    "command grep -aEvq \"^[A-Z_][A-Z0-9_]*='[^'\\$\\\\\\\\$cr]*'\\$\" \"$raw\"; [ $? -eq 1 ] || exit 1", "cr=$(printf '\\r')", "[ -z \"$(cut -d= -f1 \"$raw\" | sort | uniq -d)\" ] || exit 1",
    "command grep -aEv '^(VITE_|BETTER_AUTH_)' \"$raw\" >| \"$f\"; [ $? -le 1 ] || exit 1",
    "[ -s \"$f\" ] || exit 0", "void secret sync \"$f\" --yes || exit 1", "\n) && infisical run --env=prod -- void deploy", "Workers sync",
    "`BETTER_AUTH_*` is filtered out", "declare every key you sync", "skipped when nothing is left", "refuses (exit 1, before the sync and the deploy) any export line other than `KEY='…'` with no `'`, `\\`, `$` or carriage return inside",
    "Line format (push and pull)", "inline comments", "`export line <n>`", "`.env line <n>`", "prints `line <n>`, never the line",
  ])
    expect(agents).toContain(s);
});

// Runs the AGENTS.md production snippet against fake infisical and void on PATH. `calls` is every command they saw, `synced` the file given to sync.
async function route(env: Record<string, string>) {
  const on = join(tmp(), "app");
  await scaffold({ name: "app", framework: "react", tailwind: false, shadcn: false, zodRpc: false, auth: false, secrets: true }, on, fake(on));
  const block = /```bash\n([\s\S]*?)\n```/.exec(readFileSync(join(on, "AGENTS.md"), "utf8"))![1]!;
  const bin = join(tmp(), "bin"), calls = join(tmp(), "calls"), synced = join(tmp(), "synced");
  mkdirSync(bin);
  // SIG_EXPORT / SIG_FILTER: send TERM to the route's subshell only (the fake's parent) during the export / the VITE_ filter.
  writeFileSync(join(bin, "infisical"), '#!/bin/sh\necho "infisical $*" >> "$CALLS"\n[ "$1" = export ] && { [ -n "$SIG_EXPORT" ] && kill -TERM $PPID; printf \'%s\' "$FAKE_EXPORT"; exit "${FAKE_EXIT:-0}"; }\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, "void"), '#!/bin/sh\necho "void $1 $2" >> "$CALLS"\ncat "$3" > "$SYNCED"\nexit "${VOID_EXIT:-0}"\n', { mode: 0o755 });
  if (env.SIG_FILTER) writeFileSync(join(bin, "grep"), '#!/bin/sh\n[ "$1" = -aEv ] && kill -TERM $PPID\nexec /usr/bin/grep "$@"\n', { mode: 0o755 });
  if (env.GREP_EXIT) writeFileSync(join(bin, "grep"), '#!/bin/sh\ncat > /dev/null\nexit "$GREP_EXIT"\n', { mode: 0o755 }); // grep itself failing (exit 2)
  const r = Bun.spawnSync([env.SHELL_BIN ?? "bash", "-c", (env.PRELUDE ?? "") + block], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SYNCED: synced, ...env } });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return { code: r.exitCode, calls: read(calls).trim().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 3).join(" ")), synced: read(synced) };
}

test("production route: a failed infisical export reaches neither the sync nor the deploy", async () => {
  const r = await route({ FAKE_EXPORT: "A=1\n", FAKE_EXIT: "3" });
  expect(r.code).not.toBe(0);
  expect(r.calls).toEqual(["infisical export --env=prod"]);
});

test("production route: syncs only the unfiltered keys, then deploys", async () => {
  const r = await route({ FAKE_EXPORT: "A_KEY='1'\nVITE_X='y'\nBETTER_AUTH_SECRET='z'\n" });
  expect([r.code, r.synced, r.calls]).toEqual([0, "A_KEY='1'\n", ["infisical export --env=prod", "void secret sync", "infisical run --env=prod"]]);
});

// One test per line: 7 route runs in one test overran bun's 5s timeout at load 110+.
for (const bad of ["DB_PASSWORD='p'ss'\n", "A_KEY='1'\nVITE_PUBLIC_PEM='line1\nSTOLEN_KEY=x'\n", "A_KEY=1\n", "A_KEY='a\\'b'\n", "A_KEY='1'\r\n", "K='a\rb'\n", "DB_PASSWORD='pa$word'\n"])
  test(`production route: an export line other than KEY='…' (no ' or \\ inside) reaches neither the sync nor the deploy (${JSON.stringify(bad)})`, async () => {
    const r = await route({ FAKE_EXPORT: bad });
    expect([r.code, r.calls, r.synced]).toEqual([1, ["infisical export --env=prod"], ""]);
  });

test("production route: skips the sync when the filtered file is empty, then deploys", async () => {
  const r = await route({ FAKE_EXPORT: "VITE_X='2'\nVITE_Y='3'\n" });
  expect([r.code, r.calls]).toEqual([0, ["infisical export --env=prod", "infisical run --env=prod"]]);
});

test("production route: a grep error (exit 2) reaches neither the sync nor the deploy", async () => {
  const r = await route({ FAKE_EXPORT: "A_KEY='1'\n", GREP_EXIT: "2" });
  expect(r.code).not.toBe(0);
  expect(r.calls).toEqual(["infisical export --env=prod"]);
});

test("production route: a failed sync never deploys", async () => {
  const r = await route({ FAKE_EXPORT: "A_KEY='1'\n", VOID_EXIT: "2" });
  expect(r.code).not.toBe(0);
  expect(r.calls).toEqual(["infisical export --env=prod", "void secret sync"]);
});

test("production route: a TERM sent only to the subshell reaches neither the sync nor the deploy", async () => {
  for (const sig of ["SIG_EXPORT", "SIG_FILTER"]) {
    const r = await route({ FAKE_EXPORT: "A_KEY='1'\n", [sig]: "1" });
    expect([sig, r.code === 0, r.calls]).toEqual([sig, false, ["infisical export --env=prod"]]);
  }
});

test("production route: a shell grep function that always exits 1 cannot switch off the line check", async () => {
  const r = await route({ FAKE_EXPORT: "DB_PASSWORD='p'ss'\n", PRELUDE: "grep() { return 1; }\n" });
  expect([r.code, r.calls, r.synced]).toEqual([1, ["infisical export --env=prod"], ""]);
});

test("production route: a failing mktemp never deletes a file a stale $f or $raw names", async () => {
  const keep = join(tmp(), "keep.txt");
  writeFileSync(keep, "keep\n");
  const fakeBin = join(tmp(), "mk");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const r = await route({ FAKE_EXPORT: "A_KEY='1'\n", PRELUDE: `PATH=${fakeBin}:$PATH; f=${keep}; raw=${keep}\n` });
  expect([r.code, r.calls, existsSync(keep)]).toEqual([1, [], true]);
});

test("production route: a repeated name (a value's quote and newline adding an override) reaches neither the sync nor the deploy", async () => {
  const r = await route({ FAKE_EXPORT: "STRIPE_SECRET_KEY='sk_real'\nVITE_BANNER='Welcome'\nSTRIPE_SECRET_KEY='sk_bad'\n" });
  expect([r.code, r.calls, r.synced]).toEqual([1, ["infisical export --env=prod"], ""]);
});

test("production route under dash: a carriage return is still refused and a good export still syncs", async () => {
  const bad = await route({ FAKE_EXPORT: "DB_PASSWORD='pa\r55'\nAPI_KEY='abc'\n", SHELL_BIN: "/bin/dash" });
  expect([bad.code, bad.calls]).toEqual([1, ["infisical export --env=prod"]]);
  const good = await route({ FAKE_EXPORT: "A_KEY='secret'\nVITE_X='y'\n", SHELL_BIN: "/bin/dash" });
  expect([good.code, good.synced]).toEqual([0, "A_KEY='secret'\n"]);
});
