// Infisical secrets for this app: `bun run secrets:pull` replaces .env with the Infisical `dev` environment; `bun run secrets:push` seeds it from .env.
// Infisical's own output is never printed (it can carry values); failures say the exit code and the command to rerun by hand.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const ENV = ".env";
const TMP = ".env.pull-tmp";
const LINK_FILES = [".infisical.yaml", ".infisical.json"]; // .json is the legacy name

class Refuse extends Error {}

// Never r.error.message: it can carry the command line. Code only.
const failed = (r: ReturnType<typeof spawnSync>): string =>
  r.error
    ? (r.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "the Infisical CLI was not found on PATH"
      : `could not run infisical (${(r.error as NodeJS.ErrnoException).code})`
    : `infisical exited ${r.status ?? r.signal}`;

// Key names only, never values. Names come from parseEnv (what Void reads .env with); a line scan adds only what parseEnv
// skips (names outside [\w.]+, which Infisical would still receive) and finds multi-line values and `export ` lines, which
// `infisical secrets set --file` cannot take. A name is printed only when it is plain; anything else is reported as `line <n>`.
const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
const ENTRY = /^\s*(export\s+)?([^\s=#][^=]*?)\s*=\s*(.*)$/;
const ONE_LINE = /^(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`)\s*(?:#.*)?$/; // a quoted value closed on its own line
type Entry = { name: string; label: string };
const scan = (text: string): { names: Entry[]; unsupported: string[] } => {
  const lines = text.split(/\r?\n/);
  const label = (name: string, i: number) => (SAFE.test(name) ? name : `line ${i + 1}`);
  const unsupported: string[] = [];
  const names: Entry[] = Object.keys(parseEnv(text)).map((name) => ({ name, label: label(name, lines.findIndex((l) => l.includes(name))) }));
  let open = "";
  lines.forEach((l, i) => {
    if (open) { if (l.includes(open)) open = ""; return; }
    const m = ENTRY.exec(l);
    if (!m) return;
    const [, ex, name, v] = m as unknown as [string, string | undefined, string, string];
    const quoted = /^['"`]/.test(v);
    if (ex || (quoted && !ONE_LINE.test(v))) unsupported.push(label(name, i));
    if (quoted && !v.slice(1).includes(v[0]!)) open = v[0]!;
    if (!/^[\w.]+$/.test(name)) names.push({ name, label: label(name, i) });
  });
  return { names, unsupported };
};

function requireLink(): void {
  if (!LINK_FILES.some((f) => existsSync(f)))
    throw new Refuse(
      `This folder is not linked to Infisical (no ${LINK_FILES.join(" or ")}).\n` +
        "Link it first: run the secret-sync skill, or `infisical init --project-id <id>`.",
    );
}

// Spec key naming rules 1, 5 and 6 (kept in step with tests/unit/key-names.test.ts in the scaffolder). Names only, never values.
const badName = (k: string): boolean =>
  !/^[A-Z][A-Z0-9_]*$/.test(k) || (/^VITE_/.test(k) && /SECRET|PASSWORD|TOKEN|PRIVATE/.test(k)) || /^(__VOID_|VOID_)/.test(k);

function push(): void {
  requireLink();
  if (!existsSync(ENV)) throw new Refuse(`No ${ENV} to push. Nothing was sent.`);
  const { names: entries, unsupported } = scan(readFileSync(ENV, "utf8"));
  if (unsupported.length)
    throw new Refuse(
      `Refusing to push: multi-line values and "export " lines are not supported (Infisical reads ${ENV} one line at a time): ${[...new Set(unsupported)].join(", ")}.\n` +
        "Nothing was sent. Put each value on one line without `export`, then rerun.",
    );
  const names = [...new Set(entries.map((e) => e.name))];
  if (!names.length) throw new Refuse(`${ENV} has no keys. Nothing was sent.`);
  const bad = entries.filter((e) => badName(e.name)).map((e) => e.label);
  if (bad.length)
    throw new Refuse(
      `Refusing to push: these names break the key naming convention (UPPER_SNAKE_CASE; a VITE_ name never contains SECRET, PASSWORD, TOKEN or PRIVATE; never __VOID_ or VOID_): ${[...new Set(bad)].join(", ")}.\n` +
        "Nothing was sent. Rename them in .env and env.ts, then rerun.",
    );
  const args = ["secrets", "set", "--file", ENV, "--env=dev", "--silent"];
  const r = spawnSync("infisical", args, { stdio: ["ignore", "pipe", "pipe"] }); // both streams captured, never printed
  if (r.error || r.status !== 0)
    throw new Refuse(
      `${failed(r)}.\n` +
        `Some keys may already have been set in Infisical. Rerun by hand: infisical ${args.join(" ")}`,
    );
  console.log(`Pushed ${names.length} keys from ${ENV} to the Infisical dev environment.`);
}

function pull(): void {
  requireLink();
  const args = ["export", "--env=dev", "--format=dotenv", "--expand=false", "--silent", `--output-file=${TMP}`];
  // spawnSync blocks handlers until the child exits; the child gets the signal too, so this runs right after.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(sig, () => {
      rmSync(TMP, { force: true });
      process.exit(1);
    });
  try {
    rmSync(TMP, { force: true });
    writeFileSync(TMP, "", { mode: 0o600 }); // exists at 0600 before Infisical writes into it
    const r = spawnSync("infisical", args, { stdio: ["ignore", "pipe", "pipe"] }); // both streams captured, never printed
    if (r.error || r.status !== 0)
      throw new Refuse(
        `${failed(r)}.\n` +
          `${ENV} was not changed. Rerun by hand: infisical ${args.join(" ")}`,
      );
    chmodSync(TMP, 0o600);
    const exp = scan(readFileSync(TMP, "utf8"));
    if (exp.unsupported.length)
      throw new Refuse(
        `The Infisical dev export has multi-line values or "export " lines, which this script cannot round-trip: ${[...new Set(exp.unsupported)].join(", ")}.\n` +
          `${ENV} was not changed. Store each value on one line in Infisical.`,
      );
    if (existsSync(ENV)) {
      const have = new Set(exp.names.map((e) => e.name));
      const missing = scan(readFileSync(ENV, "utf8")).names.filter((e) => !have.has(e.name)).map((e) => e.label);
      if (missing.length)
        throw new Refuse(
          `The Infisical dev export lacks keys your ${ENV} has: ${[...new Set(missing)].join(", ")}.\n` +
            `${ENV} was not changed. Wrong project, or dev was never seeded?`,
        );
    }
    renameSync(TMP, ENV);
    console.log(`${ENV} replaced from the Infisical dev environment.`);
  } finally {
    rmSync(TMP, { force: true }); // no-op after a successful rename
  }
}

const commands: Record<string, () => void> = { pull, push };
const cmd = commands[process.argv[2] ?? ""];
try {
  if (!cmd) throw new Refuse(`Usage: bun scripts/secrets.ts <${Object.keys(commands).join("|")}>`);
  cmd();
} catch (e) {
  console.error(e instanceof Refuse ? e.message : `secrets: ${(e as Error).message}`);
  process.exit(1);
}
