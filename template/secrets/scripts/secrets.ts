// Infisical secrets for this app: `bun run secrets:pull` replaces .env with the Infisical `dev` environment; `bun run secrets:push` seeds it from .env.
// Infisical's own output is never printed (it can carry values); failures say the exit code and the command to rerun by hand.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const ENV = ".env";
const TMP = ".env.pull-tmp";
const LINK_FILES = [".infisical.yaml", ".infisical.json"]; // .json is the legacy name

class Refuse extends Error {}

// Key names only, never values. shortcut: line-based, so a continuation line of a multi-line value that looks like KEY= is read as a key.
const keysOf = (text: string): string[] =>
  text.split("\n").flatMap((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1] ?? []);

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

// Looser than keysOf so names like `my-key` or `1ABC` are seen and refused rather than skipped.
const namesOf = (text: string): string[] =>
  text.split("\n").flatMap((l) => (/^\s*(?:export\s+)?([^\s=#][^=]*?)\s*=/.exec(l)?.[1] ?? []));

function push(): void {
  requireLink();
  if (!existsSync(ENV)) throw new Refuse(`No ${ENV} to push. Nothing was sent.`);
  const names = [...new Set(namesOf(readFileSync(ENV, "utf8")))];
  if (!names.length) throw new Refuse(`${ENV} has no keys. Nothing was sent.`);
  const bad = names.filter(badName);
  if (bad.length)
    throw new Refuse(
      `Refusing to push: these names break the key naming convention (UPPER_SNAKE_CASE; a VITE_ name never contains SECRET, PASSWORD, TOKEN or PRIVATE; never __VOID_ or VOID_): ${bad.join(", ")}.\n` +
        "Nothing was sent. Rename them in .env and env.ts, then rerun.",
    );
  const args = ["secrets", "set", "--file", ENV, "--env=dev", "--silent"];
  const r = spawnSync("infisical", args, { stdio: ["ignore", "pipe", "pipe"] }); // both streams captured, never printed
  if (r.error || r.status !== 0)
    throw new Refuse(
      `infisical exited ${r.error ? "without running (is the Infisical CLI installed?)" : (r.status ?? r.signal)}.\n` +
        `Some keys may already have been set in Infisical. Rerun by hand: infisical ${args.join(" ")}`,
    );
  console.log(`Pushed ${names.length} keys from ${ENV} to the Infisical dev environment.`);
}

function pull(): void {
  requireLink();
  const args = ["export", "--env=dev", "--format=dotenv", "--expand=false", "--silent", `--output-file=${TMP}`];
  try {
    rmSync(TMP, { force: true });
    writeFileSync(TMP, "", { mode: 0o600 }); // exists at 0600 before Infisical writes into it
    const r = spawnSync("infisical", args, { stdio: ["ignore", "pipe", "pipe"] }); // both streams captured, never printed
    if (r.error || r.status !== 0)
      throw new Refuse(
        `infisical exited ${r.error ? "without running (is the Infisical CLI installed?)" : (r.status ?? r.signal)}.\n` +
          `${ENV} was not changed. Rerun by hand: infisical ${args.join(" ")}`,
      );
    chmodSync(TMP, 0o600);
    if (existsSync(ENV)) {
      const have = new Set(keysOf(readFileSync(TMP, "utf8")));
      const missing = keysOf(readFileSync(ENV, "utf8")).filter((k) => !have.has(k));
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
