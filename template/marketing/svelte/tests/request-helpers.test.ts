import { Hono } from "hono";
import { expect, it, vi } from "vite-plus/test";
import { afterResponse } from "../src/lib/after-response";
import { fields } from "../src/lib/fields";
import { verifyTurnstile } from "../src/turnstile-verify";

// fields(): one reader for the body encodings a mail app, a plain form and the pages use.
const read = async (init: RequestInit) => {
  const app = new Hono().post("/x", async (c) => c.json(await fields(c)));
  return (await app.request("/x", { method: "POST", ...init })).json();
};

it("reads JSON, urlencoded and multipart bodies, ignores non-strings, and gives {} for an unreadable or missing body", async () => {
  expect(await read({ headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "1", b: 2, c: null, d: ["x"] }) })).toEqual({ a: "1" });
  expect(await read({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click&scope=all" })).toEqual({ "List-Unsubscribe": "One-Click", scope: "all" });
  const form = new FormData();
  form.set("scope", "all");
  expect(await read({ body: form })).toEqual({ scope: "all" });
  expect(await read({ headers: { "content-type": "application/json" }, body: "{not json" })).toEqual({});
  expect(await read({ headers: { "content-type": "application/json" }, body: "[1]" })).toEqual({ });
  expect(await read({})).toEqual({});
});

// verifyTurnstile(): fails closed, and an empty token never reaches Cloudflare (the test secret passes anything).
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

it("refuses an empty token or secret before calling Cloudflare", async () => {
  const f = answer({ success: true });
  expect(await verifyTurnstile("", "secret", f)).toBe(false);
  expect(await verifyTurnstile("token", "", f)).toBe(false);
  expect(await verifyTurnstile("x".repeat(2049), "secret", f)).toBe(false);
  expect(f).not.toHaveBeenCalled();
});

it("passes only on success true, and posts the secret and token to siteverify", async () => {
  const f = answer({ success: true });
  expect(await verifyTurnstile("token", "secret", f)).toBe(true);
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  expect(String(init.body)).toBe("secret=secret&response=token");
  expect(await verifyTurnstile("token", "secret", answer({ success: false }))).toBe(false);
  expect(await verifyTurnstile("token", "secret", answer({ success: "true" }))).toBe(false);
  expect(await verifyTurnstile("token", "secret", answer({}))).toBe(false);
});

it("afterResponse hands the work to waitUntil, logs a failure instead of throwing, and copes with no execution context", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const held: Promise<unknown>[] = [];
  afterResponse({ executionCtx: { waitUntil: (p) => void held.push(p) } }, Promise.reject(new Error("mail down")), "a send");
  expect(held).toHaveLength(1);
  await held[0];
  expect(error).toHaveBeenCalledWith("a send failed", "mail down");
  const none = { get executionCtx(): never { throw new Error("no execution context"); } };
  afterResponse(none, Promise.resolve(), "nothing"); // runs on its own; no throw
  error.mockRestore();
});

it("fails closed on a non-2xx answer, a body that is not JSON and a network error", async () => {
  expect(await verifyTurnstile("token", "secret", answer({ success: true }, 500))).toBe(false);
  expect(await verifyTurnstile("token", "secret", vi.fn(async () => new Response("<html>")))).toBe(false);
  expect(await verifyTurnstile("token", "secret", vi.fn(async () => { throw new Error("offline"); }))).toBe(false);
});
