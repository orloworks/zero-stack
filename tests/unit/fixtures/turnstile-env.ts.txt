import { defineEnv, string } from "void/env";

// The site key is public (it is embedded in the browser bundle); builds ignore VITE_* from .env, so the default below is what ships
// unless the build shell sets it. It is Cloudflare's always-pass test key. The secret has no default.
export default defineEnv({
  TURNSTILE_SECRET_KEY: string(),
  VITE_TURNSTILE_SITE_KEY: string().default("1x00000000000000000000AA"),
});
