import { expect, it, vi } from "vite-plus/test";

// Tests run in Node without Worker bindings, so replace `void` modules with vi.mock.
vi.mock("void", () => ({ defineHandler: (fn: unknown) => fn }));

it("GET /api/hello returns the greeting", async () => {
  const { GET } = await import("../routes/api/hello");
  expect(await (GET as () => unknown)()).toMatchObject({ message: "Hello from Void" });
});
