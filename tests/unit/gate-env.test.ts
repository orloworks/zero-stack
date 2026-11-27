import { expect, test } from "bun:test";
import { editEnv } from "../../scripts/gate/env";

const env = "A=1\nSIGNUP_ALLOWLIST=@example.com\nB=2\n";

test("editEnv replaces an existing key's line in place", () => {
  expect(editEnv(env, { SIGNUP_ALLOWLIST: "x@y.test,z@y.test" })).toBe("A=1\nSIGNUP_ALLOWLIST=x@y.test,z@y.test\nB=2\n");
});

test("editEnv appends a key the file lacks, after a missing final newline too", () => {
  expect(editEnv(env, { NEW: "v" })).toBe(`${env}NEW=v\n`);
  expect(editEnv("A=1", { NEW: "v" })).toBe("A=1\nNEW=v\n");
  expect(editEnv("", { NEW: "v" })).toBe("NEW=v\n");
});

test("editEnv deletes a key's line on request, and does nothing for a key that is not there", () => {
  expect(editEnv(env, { SIGNUP_ALLOWLIST: null })).toBe("A=1\nB=2\n");
  expect(editEnv(env, { GONE: null })).toBe(env);
});

test("editEnv writes an empty value and keeps a key that only starts like another", () => {
  expect(editEnv("ADMIN_EMAILS_X=1\nADMIN_EMAILS=a\n", { ADMIN_EMAILS: "" })).toBe("ADMIN_EMAILS_X=1\nADMIN_EMAILS=\n");
});

test("editEnv writes a value literally (no $ replacement patterns) and handles several keys, each once", () => {
  expect(editEnv("A=1\nB=2\n", { A: "$&-$1", B: null, C: "3" })).toBe("A=$&-$1\nC=3\n");
});

test("editEnv matches the key literally, not as a pattern", () => {
  expect(editEnv("AXB=1\n", { "A.B": "2" })).toBe("AXB=1\nA.B=2\n");
});
