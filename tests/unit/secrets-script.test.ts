import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../template/secrets/scripts/secrets.ts");

// A linked folder with a fake infisical on PATH: it logs its argv to `calls` and writes FAKE_EXPORT to --output-file.
function app(env: string, exported = "") {
  const dir = mkdtempSync(join(tmpdir(), "zs-sec-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "infisical"), '#!/bin/sh\necho "$*" >> "$FAKE_LOG"\nfor a in "$@"; do case "$a" in --output-file=*) out="${a#--output-file=}";; esac; done\n[ -n "$out" ] && printf \'%s\' "$FAKE_EXPORT" > "$out"\nexit 0\n');
  chmodSync(join(bin, "infisical"), 0o755);
  writeFileSync(join(dir, ".infisical.yaml"), "x: 1\n");
  writeFileSync(join(dir, ".env"), env);
  const run = (cmd: "push" | "pull") => {
    const r = Bun.spawnSync([process.execPath, script, cmd], {
      cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_EXPORT: exported },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), called: existsSync(log), env: readFileSync(join(dir, ".env"), "utf8"), tmp: existsSync(join(dir, ".env.pull-tmp")) };
  };
  return run;
}

// Lines outside spec story 11's strict format. Each sits on line 2, after a good line; `hunter2` is the value that must never print.
const OUTSIDE: [string, string][] = [
  ["backtick", "TOKEN_KEY=`hunter2`\n"],
  ["escaped newline", 'PRIVATE_KEY="hunter2\\nb"\n'],
  ["quote inside double quotes", 'A_KEY="hunter2\'s"\n'],
  ["spaces around =", "A = hunter2\n"],
  ["leading space in the value", "A= hunter2\n"],
  ["quote inside an unquoted value", 'A=x"hunter2\n'],
  ["backslash", "A=foo\\hunter2\n"],
  ["quote inside single quotes", "A='x\"hunter2'\n"],
  ["inline comment", "A=foo # hunter2\n"],
  ["export line", "export A=hunter2\n"],
  ["multi-line value", 'A="hunter2\nB=2"\n'],
  ["no =", "hunter2\n"],
  ["CRLF", "A=hunter2\r\n"],
];

for (const [what, line] of OUTSIDE)
  test(`push refuses a line outside the format (${what}) by line number, before infisical runs`, () => {
    const r = app(`GOOD=1\n${line}`)("push");
    expect([r.code, r.called, r.out.includes("line 2")]).toEqual([1, false, true]);
    expect(r.out).not.toContain("hunter2");
    expect(r.out).not.toContain("GOOD");
  });

test("push names a bad name from a well-formed line, before infisical runs", () => {
  const r = app("GOOD=1\nlower_key=1\n")("push");
  expect([r.code, r.called, r.out.includes("lower_key"), r.out.includes("GOOD")]).toEqual([1, false, true, false]);
});

test("push accepts every form in the format and counts the keys", () => {
  const r = app("\n  \n# a comment\nA=\nB=foo bar\nC=\"x\"\nD='x'\n")("push");
  expect([r.code, r.called, r.out]).toEqual([0, true, "Pushed 4 keys from .env to the Infisical dev environment.\n"]);
});

test("push refuses a file with no keys", () => {
  const r = app("# only a comment\n")("push");
  expect([r.code, r.called, r.out.includes("no keys")]).toEqual([1, false, true]);
});

test("pull refuses an export with an escaped quote, leaving .env untouched", () => {
  const r = app("A_KEY=1\n", "A_KEY='a\\'b'\n")("pull");
  expect([r.code, r.env, r.tmp, r.out.includes("export line 1")]).toEqual([1, "A_KEY=1\n", false, true]);
});

test("pull refuses a multi-line export by line number, printing no fragment of the value", () => {
  const r = app("A_KEY=1\n", "A_KEY='1'\nNOTE='Don't share\nhunter2-pass=it's'\n")("pull");
  expect([r.code, r.env, r.tmp, r.out.includes("export line 2"), r.out.includes("export line 3")]).toEqual([1, "A_KEY=1\n", false, true, true]);
  for (const frag of ["hunter2", "share", "NOTE"]) expect(r.out).not.toContain(frag);
});

test("pull refuses when the local .env has a line outside the format, by line number", () => {
  for (const [, line] of OUTSIDE) {
    const env = `A=1\n${line}`;
    const r = app(env, "A=1\nB=2\n")("pull");
    expect([line, r.code, r.env, r.tmp, r.out.includes(".env line 2")]).toEqual([line, 1, env, false, true]);
    expect(r.out).not.toContain("hunter2");
  }
});

test("pull refuses an export that lacks a local key, naming it", () => {
  const r = app("A=1\nSTRIPE_SECRET_KEY=sk_local\n", "A='2'\n")("pull");
  expect([r.code, r.env, r.tmp, r.out.includes("STRIPE_SECRET_KEY"), r.out.includes("sk_local")]).toEqual([1, "A=1\nSTRIPE_SECRET_KEY=sk_local\n", false, true, false]);
});

test("pull replaces .env when the export has every local key", () => {
  const r = app("# note\nA=1\nB=\"x y\"\n", "A='2'\nB='x y'\nC='${X}'\n")("pull");
  expect([r.code, r.env, r.tmp]).toEqual([0, "A='2'\nB='x y'\nC='${X}'\n", false]);
});
