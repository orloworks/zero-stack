import type { Config } from "../flags";

// src/mail.ts: the one send() behind both Better Auth mail callbacks. Better Auth catches and logs whatever they throw, so the request
// still succeeds (D7); throwing after logging the code is what makes a failed send visible. Checks both failure shapes of sendEmail.
// It lives under src/ because Void infers the email binding (and the dev inbox) only from files in its scanned dirs, not the root auth.ts;
// void/email is imported on use because Void's plugin loads auth.ts at startup (vp test included), where a top-level import fails on a CJS dependency.
export const MAIL_TS = `export async function send(to: string, subject: string, url: string) {
  const { sendEmail } = await import("void/email");
  const result = await sendEmail({ to, subject, text: \`\${subject}\\n\\n\${url}\\n\` });
  if (result.ok) return;
  const codes = "error" in result ? [result.error.code] : result.deliveries.flatMap((d) => (d.ok ? [] : [d.error.code]));
  console.error(\`email send failed (\${subject}): \${codes.join(", ")}\`);
  throw new Error(\`email send failed: \${codes.join(", ")}\`);
}
`;

// deleteUser with --storage (D7, D13): purge before deleting the user, and fail closed (the error aborts the deletion before any row is removed);
// sweep again after, for an upload that raced the deletion. The thrown code is what the Account page maps to its partial-purge copy.
const STORAGE_DELETE_USER = `  user: {
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        try {
          await purgeUserFiles(user.id);
        } catch (e) {
          console.error(\`storage purge failed for \${user.id}\`, e);
          throw APIError.from("INTERNAL_SERVER_ERROR", { code: "STORAGE_PURGE_FAILED", message: "Could not delete the account's files." });
        }
      },
      afterDelete: async (user) => {
        try {
          await purgeUserFiles(user.id);
        } catch (e) {
          console.error(\`storage resweep failed for \${user.id}\`, e);
        }
      },
    },
  },`;

const DELETE_PASSWORD_HOOK = `  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/delete-user" && !(typeof ctx.body?.password === "string" && ctx.body.password.length > 0)) {
        throw new APIError("BAD_REQUEST", { message: "Password required" });
      }
    }),
  },`;

// Gate on user creation (D-invite): every sign-up path goes through it. No row is written and no mail is sent when it throws.
const INVITE_ONLY_HOOK = `  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!signupAllowed(env.SIGNUP_ALLOWLIST, user.email))
            throw new APIError("FORBIDDEN", { code: "SIGNUP_INVITE_ONLY", message: "Signups are invite-only right now." });
        },
      },
    },
  },`;

// The root auth.ts, written whole from the enabled features (one owner; add-ons contribute parts here, never patch the file).
// Svelte only: react, vue and solid --auth keep v0.1 output (no auth.ts).
export function composeAuthTs(config: Config): string {
  const options = [
    // Not requireEmailVerification: sign-in never waits on mail (D8). Reset revokes every other session (D30).
    ...(config.email
      ? [
          `  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: ({ user, url }) => send(user.email, "Reset your password", url),
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: ({ user, url }) => send(user.email, "Verify your email", url),
  },`,
        ]
      : []),
    // Better Auth's captcha plugin guards its default endpoints (sign-up, sign-in, request-password-reset); the guard refuses a test secret off localhost (D14).
    ...(config.turnstile
      ? ['  plugins: [captcha({ provider: "cloudflare-turnstile", secretKey: turnstileSecret(env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_URL) })],']
      : []),
    ...(config.inviteOnly ? [INVITE_ONLY_HOOK] : []),
    // Better Auth skips the password for sessions under freshAge, so this hook requires it.
    ...(config.accountDeletion ? [config.storage ? STORAGE_DELETE_USER : "  user: { deleteUser: { enabled: true } },", DELETE_PASSWORD_HOOK] : []),
  ];
  const del = config.accountDeletion && config.storage;
  const ba = config.accountDeletion ? 'import { APIError, createAuthMiddleware } from "better-auth/api";\n' : config.inviteOnly ? 'import { APIError } from "better-auth/api";\n' : "";
  return `import { defineAuth } from "void/auth";
${ba}${config.turnstile ? 'import { captcha } from "better-auth/plugins";\n' : ""}${config.email ? 'import { send } from "./src/mail";\n' : ""}${config.turnstile ? 'import { turnstileSecret } from "./src/turnstile-guard";\n' : ""}${config.inviteOnly ? 'import { signupAllowed } from "./src/signup-allowlist";\n' : ""}${del ? 'import { purgeUserFiles } from "./src/storage";\n' : ""}
export default defineAuth(({ defaults${config.turnstile || config.inviteOnly ? ", env" : ""} }) => ({
  ...defaults,
${options.map((o) => o + "\n").join("")}}));
`;
}
