import type { Config } from "../flags";

// A feature's slice of env.ts: the comment above defineEnv and its key lines.
export type EnvPart = { comment?: string; keys: string[] };

const TURNSTILE: EnvPart = {
  comment: `// The site key is public (it is embedded in the browser bundle); builds ignore VITE_* from .env, so the default below is what ships
// unless the build shell sets it. It is Cloudflare's always-pass test key. The secret has no default.
`,
  keys: ["TURNSTILE_SECRET_KEY: string(),", 'VITE_TURNSTILE_SITE_KEY: string().default("1x00000000000000000000AA"),'],
};

export const renderEnvTs = (parts: EnvPart[]): string | null =>
  parts.some((p) => p.keys.length)
    ? `import { defineEnv, string } from "void/env";\n\n${parts.map((p) => p.comment ?? "").join("")}export default defineEnv({\n${parts.flatMap((p) => p.keys).map((k) => `  ${k}\n`).join("")}});\n`
    : null;

// The root env.ts, written whole from the enabled features (one owner; no feature copies an env.ts). null = no feature declares a key.
export const composeEnvTs = (config: Config): string | null => renderEnvTs([...(config.turnstile ? [TURNSTILE] : [])]);
