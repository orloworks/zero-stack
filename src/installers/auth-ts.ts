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
    // Better Auth verifies the password sent to deleteUser; the Account page always sends it (D6).
    ...(config.accountDeletion ? ["  user: { deleteUser: { enabled: true } },"] : []),
  ];
  return `import { defineAuth } from "void/auth";
${config.turnstile ? 'import { captcha } from "better-auth/plugins";\n' : ""}${config.email ? 'import { send } from "./src/mail";\n' : ""}${config.turnstile ? 'import { turnstileSecret } from "./src/turnstile-guard";\n' : ""}
export default defineAuth(({ defaults${config.turnstile ? ", env" : ""} }) => ({
  ...defaults,
${options.map((o) => o + "\n").join("")}}));
`;
}
