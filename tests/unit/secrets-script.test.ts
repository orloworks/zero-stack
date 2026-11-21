import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../template/secrets/scripts/secrets.ts");
const node = Bun.which("node")!; // the generated package.json runs it with node, so its parseEnv is Node's (as Void's)

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
    const r = Bun.spawnSync([node, script, cmd], {
      cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_EXPORT: exported },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), called: existsSync(log), env: readFileSync(join(dir, ".env"), "utf8"), tmp: existsSync(join(dir, ".env.pull-tmp")) };
  };
  return run;
}

const WIN = 'WIN_DIR="C:\\\\temp\\\\"\n'; // the file holds WIN_DIR="C:\\temp\\"

test("a value ending in an escaped backslash does not hide the keys after it", () => {
  const env = `${WIN}STRIPE_SECRET_KEY=sk_test_123\nVITE_ADMIN_TOKEN=tok\n`;
  const push = app(env)("push");
  expect([push.code, push.called, push.out.includes("VITE_ADMIN_TOKEN"), push.out.includes("tok\n")]).toEqual([1, false, true, false]);
  const pull = app(env, WIN)("pull");
  expect([pull.code, pull.env, pull.tmp]).toEqual([1, env, false]);
  expect(pull.out).toContain("STRIPE_SECRET_KEY");
  expect(pull.out).toContain("VITE_ADMIN_TOKEN");
});

test("pull refuses an export with a multi-line value containing an apostrophe, printing no fragment", () => {
  const r = app("A=1\n", "A=1\nNOTE='Don't share\nhunter2-pass=word\nEND'\n")("pull");
  expect([r.code, r.env, r.tmp]).toEqual([1, "A=1\n", false]);
  expect(r.out).toContain("NOTE");
  for (const frag of ["hunter2", "share", "word", "END"]) expect(r.out).not.toContain(frag);
});

test("push refuses multi-line values and export lines before infisical runs", () => {
  const pem = 'GOOD_KEY=1\nPRIVATE_PEM="-----BEGIN KEY-----\nabcDEF=ghi\nlower_body=xyz\n-----END KEY-----"\n';
  for (const [env, named, hidden] of [[pem, "PRIVATE_PEM", ["abcDEF", "lower_body", "GOOD_KEY"]], ["A=1\nexport C=1\n", "C", ["A,"]]] as const) {
    const r = app(env)("push");
    expect([r.code, r.called, r.out.includes(named)]).toEqual([1, false, true]);
    for (const h of hidden) expect(r.out).not.toContain(h);
  }
});

test("pull refuses an export with an export line, leaving .env untouched", () => {
  const r = app("A=1\n", "A=1\nexport C=1\n")("pull");
  expect([r.code, r.env, r.tmp, r.out.includes("C")]).toEqual([1, "A=1\n", false, true]);
});

test("a CRLF .env is guarded like an LF one", () => {
  const push = app("GOOD=1\r\nVITE_API_TOKEN=x\r\n")("push");
  expect([push.code, push.called, push.out.includes("VITE_API_TOKEN")]).toEqual([1, false, true]);
  const pull = app("A=1\r\nB=2\r\n", "A=1\r\n")("pull");
  expect([pull.code, pull.out.includes("B"), pull.env]).toEqual([1, true, "A=1\r\nB=2\r\n"]);
});

test("a line parseEnv ignores is still caught: unsafe names are reported by line number, never by text", () => {
  const r = app("A=1\nstray words=hunter2\n")("push");
  expect([r.code, r.called, r.out.includes("line 2")]).toEqual([1, false, true]);
  expect(r.out).not.toContain("stray");
  expect(r.out).not.toContain("hunter2");
  const hyphen = app("my-key=1\n")("push");
  expect([hyphen.code, hyphen.out.includes("my-key")]).toEqual([1, true]);
});

test("ordinary files still push and pull", () => {
  const env = "# note\nA=1\nB=\"x y\"\nC='it\"s'\n";
  const push = app(env)("push");
  expect([push.code, push.out.includes("Pushed 3 keys")]).toEqual([0, true]);
  const pull = app(env, "A=2\nB=\"x y\"\nC=3\n")("pull");
  expect([pull.code, pull.env]).toEqual([0, "A=2\nB=\"x y\"\nC=3\n"]);
});

test("under node, a single backslash before the closing quote does not hide the keys after it", () => {
  // The review's repros: Bun's parseEnv reads \" as an escape and swallows the next quoted line; Node's does not.
  const env = 'WIN_DIR="C:\\temp\\"\nVITE_ADMIN_TOKEN="tok"\nOK=1\n'; // the file holds WIN_DIR="C:\temp\"
  const push = app(env)("push");
  expect([push.code, push.called, push.out.includes("VITE_ADMIN_TOKEN")]).toEqual([1, false, true]);
  const local = 'WIN_DIR="C:\\temp\\"\nSTRIPE_SECRET_KEY="sk_live_local"\n';
  const pull = app(local, "WIN_DIR='C:\\temp\\'\n")("pull");
  expect([pull.code, pull.env, pull.out.includes("STRIPE_SECRET_KEY"), pull.out.includes("sk_live")]).toEqual([1, local, true, false]);
});

test("push refuses inline comments, naming the key only", () => {
  for (const [env, named] of [["A=foo # note-one\n", "A"], ['B="bar" # note-two\n', "B"], ["C=x#frag-three\n", "C"]] as const) {
    const r = app(`OK=1\n${env}`)("push");
    expect([r.code, r.called, r.out.includes(`: ${named}.`)]).toEqual([1, false, true]);
    for (const h of ["note", "frag", "foo", "bar", "OK"]) expect(r.out).not.toContain(h);
  }
});

test("pull refuses when the local .env has a line it cannot check, leaving it untouched", () => {
  for (const env of ["A=1\nB=foo # note\n", "A=1\nexport B=1\n", 'A=1\nB="x\ny"\n']) {
    const r = app(env, "A=1\nB=2\n")("pull");
    expect([r.code, r.env, r.tmp, r.out.includes("B")]).toEqual([1, env, false, true]);
    expect(r.out).not.toContain("note");
  }
});

test("pull refuses an export whose quoted value hid a newline and a fake key (a' + newline + X=Y)", () => {
  const r = app("NOTE=1\n", "NOTE='a'\nX=Y'\n")("pull");
  expect([r.code, r.env, r.tmp, r.out.includes("X")]).toEqual([1, "NOTE=1\n", false, true]);
});
