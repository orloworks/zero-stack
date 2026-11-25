import { afterEach, expect, it, vi } from "vite-plus/test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createEmailTestHarness } from "void/email/testing";

// The first test's cold import of ../auth (Better Auth and the plugins) takes seconds on a loaded machine; the 5s default flakes.
const SLOW = 30_000;

// Tests run in Node without Worker bindings, so defineAuth just hands back the options.
vi.mock("void/auth", () => ({ defineAuth: (fn: (ctx: unknown) => unknown) => fn }));

// One test's console spy must not leak into the next, even when it times out.
afterEach(() => vi.restoreAllMocks());

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
}, SLOW);

// The request itself: with the real Better Auth server API, a reset request for an existing user still succeeds when send() fails.
it("a reset request succeeds when the mail cannot be sent", async () => {
  const inbox = createEmailTestHarness();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { default: define } = (await import("../auth")) as any;
  const options = define({ defaults: { emailAndPassword: { enabled: true } }, env: {} });
  const auth = betterAuth({
    ...options,
    // The mail path is under test, not password hashing (scrypt makes every sign-up slow, and slower still on a busy machine).
    emailAndPassword: { ...options.emailAndPassword, password: { hash: async (p: string) => p, verify: async ({ hash, password }: { hash: string; password: string }) => hash === password } },
    secret: "test-secret-test-secret-test-secret-123",
    baseURL: "http://localhost:5173",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  });
  await auth.api.signUpEmail({ body: { name: "Ada", email: "ada@example.com", password: "correct-horse-battery" } });
  const res = await auth.api.requestPasswordReset({ body: { email: "ada@example.com", redirectTo: "/reset-password" } });
  expect(res.status).toBe(true);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/email send failed \(Reset your password\)/));
  inbox.dispose();
}, SLOW);
