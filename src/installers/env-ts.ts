import type { Config } from "../flags";

// A feature's slice of env.ts: the comment above defineEnv and its key lines.
export type EnvPart = { comment?: string; keys: string[] };

const TURNSTILE: EnvPart = {
  comment: `// The site key is public (it is embedded in the browser bundle); builds ignore VITE_* from .env, so the default below is what ships
// unless the build shell sets it. It is Cloudflare's always-pass test key. The secret has no default.
`,
  keys: ["TURNSTILE_SECRET_KEY: string(),", 'VITE_TURNSTILE_SITE_KEY: string().default("1x00000000000000000000AA"),'],
};

const INVITE_ONLY: EnvPart = { keys: ["SIGNUP_ALLOWLIST: string(),"] };
// U4: with --admin the invites live in the database, so the secret is one source among two: optional, and empty admits no one by itself.
const INVITE_ONLY_ADMIN: EnvPart = { keys: ['SIGNUP_ALLOWLIST: string().default(""),'] };

// Optional with an empty default (U3): unset or empty means no admins and /admin answers 404, while the app keeps serving. A required key would 500 every request.
const ADMIN: EnvPart = { keys: ['ADMIN_EMAILS: string().default(""),'] };

// The scaffold's .env holds placeholders, so a fresh app serves; both keys are required, so a deploy fails until they are set. STRIPE_API_URL is for
// tests only (a fake Stripe); src/stripe.ts refuses it unless it points at localhost.
const PAYMENTS: EnvPart = { keys: ["STRIPE_SECRET_KEY: string(),", "STRIPE_WEBHOOK_SECRET: string(),", "STRIPE_API_URL: string().optional(),"] };

export const renderEnvTs = (parts: EnvPart[]): string | null =>
  parts.some((p) => p.keys.length)
    ? `import { defineEnv, string } from "void/env";\n\n${parts.map((p) => p.comment ?? "").join("")}export default defineEnv({\n${parts.flatMap((p) => p.keys).map((k) => `  ${k}\n`).join("")}});\n`
    : null;

// The root env.ts, written whole from the enabled features (one owner; no feature copies an env.ts). null = no feature declares a key.
export const composeEnvTs = (config: Config): string | null => renderEnvTs([...(config.turnstile ? [TURNSTILE] : []), ...(config.inviteOnly ? [config.admin ? INVITE_ONLY_ADMIN : INVITE_ONLY] : []), ...(config.admin ? [ADMIN] : []), ...(config.payments ? [PAYMENTS] : [])]);
