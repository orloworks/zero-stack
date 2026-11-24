import type { Config } from "../flags";

// src/mail.ts: the one send() behind both Better Auth mail callbacks. Better Auth catches and logs whatever they throw, so the request
// still succeeds (D7); throwing after logging the code is what makes a failed send visible. Checks both failure shapes of sendEmail.
// It lives under src/ because Void infers the email binding (and the dev inbox) only from files in its scanned dirs, not the root auth.ts;
// void/email is imported on use because Void's plugin loads auth.ts at startup (vp test included), where a top-level import fails on a CJS dependency.
export const MAIL_TS = `export async function send(to: string, subject: string, url: string, intro = subject) {
  const { sendEmail } = await import("void/email");
  const result = await sendEmail({ to, subject, text: \`\${intro}\\n\\n\${url}\\n\` });
  if (result.ok) return;
  const codes = "error" in result ? [result.error.code] : result.deliveries.flatMap((d) => (d.ok ? [] : [d.error.code]));
  console.error(\`email send failed (\${subject}): \${codes.join(", ")}\`);
  throw new Error(\`email send failed: \${codes.join(", ")}\`);
}
`;

// deleteUser with --storage (D7, D13): purge before deleting the user, and fail closed (the error aborts the deletion before any row is removed);
// sweep again after, for an upload that raced the deletion. The thrown code is what the Account page maps to its partial-purge copy.
const STORAGE_BEFORE_DELETE = `      beforeDelete: async (user) => {
        try {
          await purgeUserFiles(user.id);
        } catch (e) {
          console.error(\`storage purge failed for \${user.id}\`, e);
          throw APIError.from("INTERNAL_SERVER_ERROR", { code: "STORAGE_PURGE_FAILED", message: "Could not delete the account's files." });
        }
      },`;
const STORAGE_AFTER_DELETE = `      afterDelete: async (user) => {
        try {
          await purgeUserFiles(user.id);
        } catch (e) {
          console.error(\`storage resweep failed for \${user.id}\`, e);
        }
      },`;
// With --admin the resweep after any delete (self or admin) lives in databaseHooks.user.delete.after, so deleteUser keeps only the purge-first hook (U1).
const storageDeleteUser = (afterDelete: boolean) => `    deleteUser: {
      enabled: true,
${STORAGE_BEFORE_DELETE}${afterDelete ? `\n${STORAGE_AFTER_DELETE}` : ""}
    },`;

const DELETE_PASSWORD_HOOK = `  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/delete-user" && !(typeof ctx.body?.password === "string" && ctx.body.password.length > 0)) {
        throw new APIError("BAD_REQUEST", { message: "Password required" });
      }
    }),
  },`;

// Gate on user creation: every sign-up path goes through it. No row is written and no mail is sent when it throws.
// With --admin the list is the env secret OR the invites in the database (E10): every call site asks inviteAllowed (given the secret from defineAuth's env, as ADMIN_EMAILS is) instead of the bare matcher.
const allowed = (db: boolean, email: string) => (db ? `(await inviteAllowed(${email}, env.SIGNUP_ALLOWLIST))` : `signupAllowed(env.SIGNUP_ALLOWLIST, ${email})`);
const inviteOnlyUserCreate = (db: boolean) => `      create: {
        before: async (user) => {
          if (!${allowed(db, "user.email")})
            throw new APIError("FORBIDDEN", { code: "SIGNUP_INVITE_ONLY", message: "Signups are invite-only right now." });
        },
      },`;

// --admin (src/admin.ts, src/admin-guard.ts). Better Auth's admin plugin supplies the endpoints, bans and sessions; the guard refuses and audits (E1, E3).
const BANNED_MESSAGE = "This account has been blocked. Contact the site owner.";
const lastSignIn = `    additionalFields: { lastSignInAt: { type: "date", required: false, input: false } },`;
// The only write at sign-in (E9): the guard is the only writer of role (O3).
const ADMIN_SESSION_CREATE = `      create: {
        before: async (session, ctx) => {
          await ctx?.context.internalAdapter.updateUser(session.userId, { lastSignInAt: new Date() });
        },
      },`;
// After any user is deleted (self-delete or the admin plugin's remove-user): sweep the files once more (an upload that raced the delete), then clear the user's email from the audit log.
const adminUserDelete = (storage: boolean) => `      delete: {
        after: async (user) => {${storage ? `
          try {
            await purgeUserFiles(user.id);
          } catch (e) {
            console.error(\`storage resweep failed for \${user.id}\`, e);
          }` : ""}
          try {
            await redactAudit(user.email);
          } catch (e) {
            console.error(\`audit redaction failed for \${user.id}\`, e);
          }
        },
      },`;

// databaseHooks is one object: each add-on contributes a part under user or session (already indented), and this is the only place the property is
// written, so two add-ons can never emit a second databaseHooks key (a duplicate property: the last one wins at runtime).
type DatabaseHookParts = { user: string[]; session: string[] };
function databaseHooks(parts: DatabaseHookParts): string[] {
  const section = (name: string, p: string[]) => (p.length ? `    ${name}: {\n${p.join("\n")}\n    },\n` : "");
  const body = section("user", parts.user) + section("session", parts.session);
  return body ? [`  databaseHooks: {\n${body}  },`] : [];
}

// Password after verification: the inbox owner picks the password, so a password chosen before the inbox is proven never signs in (an attacker who signs up an
// invited address first, or after the owner, gets nothing). A plugin, so its hooks run after the captcha plugin and coexist with the account-deletion hook.
// - sign-up: the body's password is replaced by a random one nobody sees (the page sends none). Hooks run before Better Auth validates the body.
// - sign-up, repeat sign-up and sign-in for an unverified user: mail a set-password link, a Better Auth reset token. There is no emailVerification config,
//   so Better Auth never mints a plain verify link (/send-verification-email answers 400). Nothing is deleted, so a repeat sign-up cannot lock the owner out.
//   Mail goes only for a request Better Auth accepted (sign-in: only the wrong-password refusal), only while the address is on the list, and only when the user
//   has no unexpired set-password or reset link, so a new one goes out after the last expires or is used.
// - reset-password: a valid token proves the inbox, so it marks an unverified user verified, if the list still holds the address; if not, the reset is refused
//   with Better Auth's invalid-token error. Verified users reset as usual. The reset then replaces the random password.
const invitePlugin = (db: boolean) => `{
      id: "invite-only",
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === "/sign-up/email",
            handler: createAuthMiddleware(async (ctx) => ({ context: { body: { ...ctx.body, password: crypto.randomUUID() + crypto.randomUUID() } } })),
          },
          {
            matcher: (ctx) => ctx.path === "/reset-password",
            handler: createAuthMiddleware(async (ctx) => {
              const token = ctx.body?.token || ctx.query?.token;
              const found = typeof token === "string" && (await ctx.context.internalAdapter.findVerificationValue(\`reset-password:\${token}\`));
              if (!found || found.expiresAt <= new Date()) return;
              const user = await ctx.context.internalAdapter.findUserById(found.value);
              if (!user || user.emailVerified) return;
              if (!${allowed(db, "user.email")}) throw new APIError("BAD_REQUEST", { code: "INVALID_TOKEN", message: "Invalid token" });
              await ctx.context.internalAdapter.updateUser(user.id, { emailVerified: true });
            }),
          },
        ],
        after: [
          {
            matcher: (ctx) => ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email",
            handler: createAuthMiddleware(async (ctx) => {
              const returned = ctx.context.returned;
              if (isAPIError(returned) && !(ctx.path === "/sign-in/email" && returned.body?.code === "INVALID_EMAIL_OR_PASSWORD")) return;
              const email = ctx.body?.email;
              const found = typeof email === "string" && (await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase()));
              if (!found || found.user.emailVerified || !${allowed(db, "found.user.email")}) return;
              const unexpired = await ctx.context.adapter.findOne({
                model: "verification",
                where: [
                  { field: "value", value: found.user.id },
                  { field: "identifier", operator: "starts_with", value: "reset-password:" },
                  { field: "expiresAt", operator: "gt", value: new Date() },
                ],
              });
              if (unexpired) return;
              const token = crypto.randomUUID().replaceAll("-", "");
              const expiresIn = ctx.context.options.emailAndPassword?.resetPasswordTokenExpiresIn ?? 3600;
              await ctx.context.runInBackgroundOrAwait(
                (async () => {
                  const identifier = \`reset-password:\${token}\`;
                  await ctx.context.internalAdapter.createVerificationValue({ value: found.user.id, identifier, expiresAt: new Date(Date.now() + expiresIn * 1000) });
                  try {
                    await send(found.user.email, "Set your password", \`\${ctx.context.baseURL}/reset-password/\${token}?callbackURL=%2Freset-password\`);
                  } catch (e) {
                    // A link nobody got would block the next one for an hour (the unexpired-row check above); keep the send error if the delete fails too.
                    await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier).catch((d) => console.error("could not delete the unsent set-password link:", d instanceof Error ? d.name : "unknown error"));
                    throw e;
                  }
                })(),
              );
            }),
          },
        ],
      },
    }`;
export const INVITE_ONLY_PLUGIN = invitePlugin(false);

// --payments (src/plans.ts, src/stripe.ts, src/billing.ts). Better Auth's Stripe plugin owns checkout, the portal, the webhook and the subscription table;
// a Stripe customer is made at first checkout, not at sign-up. billingPlugins (src/billing.ts) builds the plugin, its onEvent sync and the billing guard.
const PAYMENTS_IMPORTS = 'import { billingPlugins } from "./src/billing";\n';

// With --admin and --invite-only, a link requested on the server (the admin's send-link route has no browser request behind it) for an unverified user is mailed
// as "Set your password", matching the admin page's copy; a user's own "Forgot password" keeps the reset subject.
// The root auth.ts, written whole from the enabled features (one owner; add-ons contribute parts here, never patch the file).
// react, vue and solid get only the shared rate limit (#58 D3); every add-on is svelte only.
// The one top-level user option: deleteUser (--account-deletion) and additionalFields (--admin) are parts of it, never two keys.
function userOption(config: Config): string[] {
  const deleteUser = config.accountDeletion ? (config.storage ? storageDeleteUser(!config.admin) : "    deleteUser: { enabled: true },") : "";
  if (!config.admin) return deleteUser === "    deleteUser: { enabled: true }," ? ["  user: { deleteUser: { enabled: true } },"] : deleteUser ? [`  user: {\n${deleteUser}\n  },`] : [];
  return [`  user: {\n${[lastSignIn, deleteUser].filter(Boolean).join("\n")}\n  },`];
}

export function composeAuthTs(config: Config): string {
  const options = [
    // One count across Worker instances (D3, Void docs/guide/auth.md); costs one D1 write per auth request. Off in dev, on for deployed Cloudflare requests.
    // --payments: Stripe sends webhook bursts from shared IPs, so its endpoint is never rate limited (it is signature-checked instead).
    config.payments ? '  rateLimit: { storage: "database", customRules: { "/stripe/webhook": false } },' : '  rateLimit: { storage: "database" },',
    // Sign-in never waits on mail (D8), except --invite-only: the allowlist must see a proven address, so verification is required (sign-up creates no session)
    // and is proven by the set-password link (INVITE_ONLY_PLUGIN). Reset revokes every other session (D30).
    ...(config.email
      ? [
          `  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    revokeSessionsOnPasswordReset: true,${config.inviteOnly ? "\n    requireEmailVerification: true," : ""}
    sendResetPassword: ${config.admin && config.inviteOnly ? '({ user, url }, request) => send(user.email, !request && user.emailVerified === false ? "Set your password" : "Reset your password", url)' : '({ user, url }) => send(user.email, "Reset your password", url)'},
  },${config.inviteOnly ? "" : `
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: ({ user, url }) => send(user.email, "Verify your email", url),
  },`}`,
        ]
      : []),
    // Better Auth's captcha plugin guards its default endpoints (sign-up, sign-in, request-password-reset); the guard refuses a test secret off localhost (D14).
    ...(config.turnstile || config.inviteOnly || config.admin || config.payments
      ? [
          `  plugins: [${[
            config.turnstile && 'captcha({ provider: "cloudflare-turnstile", secretKey: turnstileSecret(env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_URL) })',
            config.inviteOnly && invitePlugin(!!config.admin),
            config.admin && `admin({ bannedUserMessage: "${BANNED_MESSAGE}" })`,
            config.admin && `adminGuard({ isAdmin: (user) => isAdmin(env.ADMIN_EMAILS, user), audit: recordAudit${config.storage ? ", purge: purgeUserFiles" : ""} })`,
            config.payments && "...billingPlugins(env)",
          ]
            .filter(Boolean)
            .join(", ")}],`,
        ]
      : []),
    ...databaseHooks({
      user: [...(config.inviteOnly ? [inviteOnlyUserCreate(!!config.admin)] : []), ...(config.admin ? [adminUserDelete(!!config.storage)] : [])],
      session: config.admin ? [ADMIN_SESSION_CREATE] : [],
    }),
    ...userOption(config),
    // Better Auth skips the password for sessions under freshAge, so this hook requires it.
    ...(config.accountDeletion ? [DELETE_PASSWORD_HOOK] : []),
  ];
  const del = (config.accountDeletion || config.admin) && config.storage;
  const ba = config.accountDeletion || config.inviteOnly ? `import { APIError, createAuthMiddleware${config.inviteOnly ? ", isAPIError" : ""} } from "better-auth/api";\n` : "";
  return `import { defineAuth } from "void/auth";
${ba}${config.turnstile || config.admin ? `import { ${[config.admin && "admin", config.turnstile && "captcha"].filter(Boolean).join(", ")} } from "better-auth/plugins";\n` : ""}${config.email ? 'import { send } from "./src/mail";\n' : ""}${config.turnstile ? 'import { turnstileSecret } from "./src/turnstile-guard";\n' : ""}${config.admin ? 'import { isAdmin, recordAudit, redactAudit } from "./src/admin";\nimport { adminGuard } from "./src/admin-guard";\n' : ""}${config.inviteOnly ? (config.admin ? 'import { inviteAllowed } from "./src/invites";\n' : 'import { signupAllowed } from "./src/signup-allowlist";\n') : ""}${del ? 'import { purgeUserFiles } from "./src/storage";\n' : ""}${config.payments ? PAYMENTS_IMPORTS : ""}
export default defineAuth(({ defaults${config.turnstile || config.inviteOnly || config.admin || config.payments ? ", env" : ""} }) => ({
  ...defaults,
${options.map((o) => o + "\n").join("")}}));
`;
}
