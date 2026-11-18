import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("void/env", () => ({ env: { VITE_TURNSTILE_SITE_KEY: "test-key" } }));

// A fake window.turnstile; render keeps the options so a test can fire the widget callbacks.
let opts: Record<string, any>;
const fake = { render: vi.fn((_el: unknown, o: Record<string, unknown>) => ((opts = o), "w1")), reset: vi.fn(), remove: vi.fn() };
const el = {} as HTMLElement;
const mount = async (cb = { onToken: vi.fn(), onError: vi.fn() }) => {
  vi.resetModules();
  const { mountTurnstile } = await import("../src/lib/turnstile");
  return { ts: mountTurnstile(el, cb), ...cb };
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window = { turnstile: fake };
});
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

it("token() follows the widget; reset() and expiry clear it", async () => {
  const { ts, onToken } = await mount();
  await vi.waitFor(() => expect(fake.render).toHaveBeenCalled());
  expect(fake.render.mock.calls[0]![1]).toMatchObject({ sitekey: "test-key" });
  opts.callback("tok");
  expect(ts.token()).toBe("tok");
  ts.reset();
  expect(ts.token()).toBeNull();
  expect(fake.reset).toHaveBeenCalledWith("w1");
  opts.callback("tok2");
  opts["expired-callback"]();
  expect(ts.token()).toBeNull();
  expect(onToken).toHaveBeenLastCalledWith(null);
});

it("a challenge error resets the widget to retry and does not call onError", async () => {
  const { ts, onToken, onError } = await mount();
  await vi.waitFor(() => expect(fake.render).toHaveBeenCalled());
  opts.callback("tok");
  opts["error-callback"]();
  expect(ts.token()).toBeNull();
  expect(onToken).toHaveBeenLastCalledWith(null);
  expect(fake.reset).toHaveBeenCalledWith("w1");
  expect(onError).not.toHaveBeenCalled();
});

// The script never arrives: a fake document captures the <script> so the test controls onload/onerror.
const fakeScript = () => {
  delete (globalThis as any).window.turnstile;
  const scripts: any[] = [];
  (globalThis as any).document = { createElement: () => ({}), head: { appendChild: (s: unknown) => scripts.push(s) } };
  return scripts;
};

it("a script load failure calls onError", async () => {
  const scripts = fakeScript();
  const { onError } = await mount();
  scripts[0].onerror();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(fake.render).not.toHaveBeenCalled();
});

it("dispose removes the widget and ignores callbacks after it", async () => {
  const { ts, onToken, onError } = await mount();
  await vi.waitFor(() => expect(fake.render).toHaveBeenCalled());
  ts.dispose();
  expect(fake.remove).toHaveBeenCalledWith("w1");
  opts.callback("late");
  opts["error-callback"]();
  expect(ts.token()).toBeNull();
  expect(onToken).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("dispose before the script loads cancels the render and ignores a late load", async () => {
  const scripts = fakeScript();
  const { ts, onError } = await mount();
  ts.dispose();
  (globalThis as any).window.turnstile = fake;
  scripts[0].onload();
  await new Promise((r) => setTimeout(r, 20));
  expect(fake.render).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
