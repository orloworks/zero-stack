// Module 7: --secrets: `secrets:pull` and `secrets:push` against a fake `infisical`. Runs last: it leaves `.env` rewritten.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../shared";

export async function secretsChecks(ctx: Ctx): Promise<void> {
  const { config, app, root } = ctx;
  if (config.secrets) {
    // A fake `infisical` first on PATH records its argv (FAKE_LOG) and is driven by env: FAKE_EXIT, FAKE_EXPORT (file contents), FAKE_STDERR.
    // Like the real CLI, it rejects a --file holding an empty value.
    const bin = join(root, "fake-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "infisical"), [
      "#!/bin/sh",
      'echo "$*" >> "$FAKE_LOG"',
      '[ -n "$INFISICAL_ZS_PROBE" ] && echo leaked >> "$FAKE_LOG.probe"', // .env must never reach this child
      'for a in "$@"; do [ "$prev" = --file ] && file="$a"; prev="$a"; case "$a" in --output-file=*) out="${a#--output-file=}";; esac; done',
      '[ -n "$out" ] && printf \'%s\' "$FAKE_EXPORT" > "$out"',
      `[ -n "$file" ] && grep -Eq "^[^=]*=(''|\\"\\"|)$" "$file" && exit 1`,
      'echo "$FAKE_STDERR" >&2',
      'echo "$FAKE_STDERR"',
      'exit "${FAKE_EXIT:-0}"',
    ].join("\n") + "\n", { mode: 0o755 });
    const log = join(root, "fake-argv.log");
    const runScript = (fake: Record<string, string>, script = ["run", "secrets:pull"]) => {
      const r = Bun.spawnSync([process.execPath, ...script], {
        cwd: app, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...fake },
      });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    const envFile = join(app, ".env"), tmp = join(app, ".env.pull-tmp"), yaml = join(app, ".infisical.yaml");
    const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`secrets:pull ${what}`); };
    const checkPush = (ok: boolean, what: string) => { if (!ok) throw new Error(`secrets:push ${what}`); };

    for (const f of [".env", ".env.pull-tmp"])
      check(Bun.spawnSync(["git", "check-ignore", "-q", f], { cwd: app }).exitCode === 0, `${f} is not gitignored`);

    const before = readFileSync(envFile);
    // No link file: refuse with the link guidance.
    let r = runScript({ FAKE_EXPORT: "X=1\n" });
    check(r.code === 1 && r.out.includes("secret-sync") && r.out.includes("infisical init --project-id"), `without a link file exited ${r.code} without the guidance: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp) && !existsSync(log), "without a link file touched .env, left a temp file or ran infisical");

    writeFileSync(yaml, "workspaceId: gate\n");
    // Export lacks a key the current .env has.
    r = runScript({ FAKE_EXPORT: "BETTER_AUTH_SECRET=other\n" });
    check(r.code === 1 && r.out.includes("BETTER_AUTH_URL") && !r.out.includes("other"), `with a missing key exited ${r.code}, output: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp), "with a missing key changed .env or left a temp file");
    // Infisical fails with a secret-looking string on both streams: never printed.
    r = runScript({ FAKE_EXPORT: "BETTER_AUTH_SECRET=other\n", FAKE_EXIT: "3", FAKE_STDERR: "LEAKED-sk_live_abc123" });
    check(r.code === 1 && r.out.includes("infisical exited 3") && !r.out.includes("LEAKED") && !r.out.includes("other"), `on a failing infisical exited ${r.code}, output: ${r.out}`);
    check(readFileSync(envFile).equals(before) && !existsSync(tmp), "on a failing infisical changed .env or left a temp file");
    // Success: contents replaced verbatim, mode 0600, the expected argv; the legacy link file works too.
    // Built from the scaffold's own .env so every key it has (Turnstile, ...) is present.
    const exported = readFileSync(envFile, "utf8").replace(/^BETTER_AUTH_SECRET=.*$/m, "BETTER_AUTH_SECRET=pulled") + "EXTRA=pre post\n";
    const exportedKeys = exported.trim().split("\n").length;
    rmSync(yaml);
    writeFileSync(join(app, ".infisical.json"), "{}\n");
    r = runScript({ FAKE_EXPORT: exported });
    check(r.code === 0, `ok run exited ${r.code}: ${r.out}`);
    check(readFileSync(envFile, "utf8") === exported, ".env is not the export verbatim");
    check((statSync(envFile).mode & 0o777) === 0o600 && !existsSync(tmp), "left .env not 0600 or left a temp file");
    check(readFileSync(log, "utf8").includes("export --env=dev --format=dotenv --expand=false --silent"), `ran infisical with ${readFileSync(log, "utf8")}`);
    // The script itself rejects an unknown subcommand.
    r = runScript({}, ["scripts/secrets.ts", "bogus"]);
    check(r.code === 1 && r.out.includes("Usage"), `unknown subcommand exited ${r.code}`);
    // secrets:push. .env is now the pulled export; the fake prints a value on both streams.
    const pushed = readFileSync(envFile);
    rmSync(log, { force: true });
    r = runScript({ FAKE_STDERR: "LEAKED-sk_live_abc123" }, ["run", "secrets:push"]);
    checkPush(r.code === 0 && r.out.includes(`Pushed ${exportedKeys} keys`) && !r.out.includes("LEAKED") && !r.out.includes("pulled"), `push ok exited ${r.code}, output: ${r.out}`);
    checkPush(readFileSync(log, "utf8").trim() === "secrets set --file .env --env=dev --silent", `push ran infisical with ${readFileSync(log, "utf8")}`);
    // A .env key must not reach the infisical child's environment (an INFISICAL_* key would redirect the CLI): --no-env-file.
    writeFileSync(envFile, Buffer.concat([pushed, Buffer.from("INFISICAL_ZS_PROBE='x'\n")]));
    for (const cmd of ["secrets:push", "secrets:pull"]) runScript({ FAKE_EXPORT: pushed.toString() + "INFISICAL_ZS_PROBE='x'\n" }, ["run", cmd]);
    checkPush(!existsSync(log + ".probe"), "passed a .env key into the infisical child's environment");
    writeFileSync(envFile, pushed);
    rmSync(log);
    r = runScript({ FAKE_STDERR: "LEAKED-sk_live_abc123", FAKE_EXIT: "4" }, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes("infisical exited 4") && r.out.includes("may already have been set") && r.out.includes("Rerun by hand")
      && !/Pushed/.test(r.out) && !r.out.includes("LEAKED") && !r.out.includes("pulled"), `failing push exited ${r.code}, output: ${r.out}`);
    // Bad names: refused before infisical runs; names listed, values not.
    rmSync(log);
    writeFileSync(envFile, "lower_case=VALUE-ONE\nVITE_API_TOKEN=VALUE-TWO\nVOID_X=VALUE-THREE\nGOOD_KEY=VALUE-FOUR\n");
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && ["lower_case", "VITE_API_TOKEN", "VOID_X"].every((n) => r.out.includes(n)) && !r.out.includes("GOOD_KEY") && !r.out.includes("VALUE-"), `bad names exited ${r.code}, output: ${r.out}`);
    checkPush(!existsSync(log), "push with bad names still ran infisical");
    // Empty values: Infisical's --file rejects them, so push refuses them by line number before infisical runs.
    writeFileSync(envFile, Buffer.concat([pushed, Buffer.from("EMPTY_KEY=''\n")]));
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes(`line ${pushed.toString().split("\n").length}: Infisical rejects empty values`) && !existsSync(log), `push with an empty value exited ${r.code}, output: ${r.out}`);
    writeFileSync(envFile, pushed);
    // Lines outside the strict format (spec story 11): push refuses before infisical runs, pull refuses the same in the export (and in
    // the local .env), leaving .env as it was. Both report the line number only, never text from the line (it may be part of a value).
    writeFileSync(join(app, ".infisical.json"), "{}\n");
    const at = pushed.toString().split("\n").length; // the 1-based number of a line appended to `pushed`
    for (const bad of [
      'PRIVATE_PEM="-----BEGIN KEY-----\nhunter2=ghi\n-----END KEY-----"\n', "export C=hunter2\n", "TOKEN_KEY=`hunter2`\n",
      'PRIVATE_KEY="hunter2\\nb"\n', "A_KEY='hunter2\\'b'\n", "DB_PASSWORD='pa$hunter2'\n", 'WIN_DIR="C:\\hunter2\\"\nVITE_ADMIN_TOKEN="tok"\n',
    ]) {
      rmSync(log, { force: true });
      writeFileSync(envFile, Buffer.concat([pushed, Buffer.from(bad)]));
      r = runScript({}, ["run", "secrets:push"]);
      checkPush(r.code === 1 && r.out.includes(`line ${at}`) && !r.out.includes("hunter2") && !existsSync(log), `push with ${JSON.stringify(bad)} exited ${r.code}, output: ${r.out}`);
      r = runScript({ FAKE_EXPORT: pushed.toString() });
      check(r.code === 1 && r.out.includes(`.env line ${at}`) && !r.out.includes("hunter2") && readFileSync(envFile).equals(Buffer.concat([pushed, Buffer.from(bad)])) && !existsSync(tmp), `pull with ${JSON.stringify(bad)} in .env exited ${r.code}, output: ${r.out}`);
      writeFileSync(envFile, pushed);
      r = runScript({ FAKE_EXPORT: pushed.toString() + bad });
      check(r.code === 1 && r.out.includes(`export line ${at}`) && !r.out.includes("hunter2") && readFileSync(envFile).equals(pushed) && !existsSync(tmp), `pull with ${JSON.stringify(bad)} in the export exited ${r.code}, output: ${r.out}`);
    }
    // The generated tsconfig covers scripts/: a type error there fails tsc.
    const script = join(app, "scripts/secrets.ts"), scriptSrc = readFileSync(script);
    writeFileSync(script, Buffer.concat([scriptSrc, Buffer.from('\nconst n: number = "x";\n')]));
    const tsc = Bun.spawnSync([join(app, "node_modules/.bin/tsc"), "--noEmit"], { cwd: app });
    writeFileSync(script, scriptSrc);
    checkPush(tsc.exitCode !== 0 && /scripts\/secrets\.ts/.test(tsc.stdout.toString()), `tsc did not report a type error in scripts/secrets.ts (exit ${tsc.exitCode}): ${tsc.stdout.toString().slice(0, 300)}`);
    // No link file.
    rmSync(join(app, ".infisical.json"));
    rmSync(log, { force: true });
    r = runScript({}, ["run", "secrets:push"]);
    checkPush(r.code === 1 && r.out.includes("secret-sync") && r.out.includes("infisical init --project-id") && !existsSync(log), `push without a link file exited ${r.code}, output: ${r.out}`);
    console.log("gate: secrets:push sends the exact argv and prints only the key count; refuses bad names, lines outside the format, no link and an infisical failure without leaking a value");
    console.log("gate: secrets:pull refuses without a link / on a missing key / on a line outside the format / on an infisical failure (.env untouched, nothing leaked); ok pull is verbatim 0600");
  }
}
