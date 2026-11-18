import { expect, it, vi } from "vite-plus/test";
import { createEmailTestHarness } from "void/email/testing";

// Tests run in Node without Worker bindings, so defineAuth just hands back the options.
vi.mock("void/auth", () => ({ defineAuth: (fn: (ctx: unknown) => unknown) => fn }));

// Better Auth catches and logs what the mail callbacks throw, so the request itself still succeeds;
// send()'s contract is that a failed send is logged with its code, then thrown. The test project has no sender, so the send fails.
it("a failed send is logged with its code and thrown", async () => {
  const inbox = createEmailTestHarness();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { default: define } = (await import("../auth")) as any;
  const { emailAndPassword } = define({ defaults: { emailAndPassword: { enabled: true } }, env: {} });
  await expect(
    emailAndPassword.sendResetPassword({ user: { email: "ada@example.com" }, url: "http://localhost/reset/abc", token: "abc" }),
  ).rejects.toThrow("email send failed");
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/email send failed \(Reset your password\): [A-Z_]+/));
  expect(inbox.messages).toHaveLength(0);
  inbox.dispose();
  log.mockRestore();
});
