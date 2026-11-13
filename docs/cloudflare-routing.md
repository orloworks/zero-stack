## Cloudflare routing (Void 1.8.0)

Rules, in order:

1. Before any Cloudflare work, read `node_modules/void/docs/` and the table below. Only then consider raw Wrangler config.
2. Containers or sandbox requests: look at `void/sandbox` first (needs Workers Paid and Docker).
3. Brownfield `@cloudflare/vite-plugin` apps: use Void's `migrate-vite-cloudflare-to-void` skill.
4. Never create wrangler files. Void migrates a root `wrangler.jsonc` into `void.config.ts` itself. Extra bindings go under `cloudflare:` in `void.config.ts`.

Table checked against the `void@1.8.0` package docs. Docs paths are relative to `node_modules/void/docs/`. Status `unverified: read docs first` means not confirmed against the package docs: read the linked docs before using it.

| Need | Product | Void module or pass-through | Docs | Status |
| --- | --- | --- | --- | --- |
| HTTP API, middleware | Workers | `void/handler`, `routes/`, `middleware/` | `reference/structure.md` | verified |
| Pages, static files | Static assets | `pages/`, `public/` | `reference/structure.md` | verified |
| SQL database | D1 | `void/db`, `void/schema-d1`, `void/seed`, `void db` | `guide/database.md` | verified |
| Key-value cache | KV | `void/kv` | `guide/kv.md` | verified |
| Files, blobs | R2 | `void/storage` | `guide/storage.md` | verified |
| Realtime, coordination, per-key state | Durable Objects | `void/durable`, `durable-objects/` | `guide/durable-state.md` | verified |
| Background jobs | Queues | `queues/`, `void/queues` | `guide/queues.md` | verified |
| Run untrusted code, containers | Sandbox (Containers) | `void/sandbox` (Workers Paid and Docker) | `guide/sandboxes.md` | verified |
| LLM inference | Workers AI, AI Gateway | `void/ai` | `guide/ai.md` | verified |
| Send or receive email | Email | `void/email`, `email/` | `guide/email/sending.md`, `guide/email/receiving.md` | verified |
| Scheduled jobs | Cron Triggers | `crons/` | `reference/structure.md` | verified |
| Config and secrets | Env, secrets | `env.ts`, `void/env`, root `.env`, `void secret put` | `guide/env-vars.md` | verified |
| Sign-in, sessions | Auth | `void/auth` | `guide/auth.md` | verified |
| Postgres or MySQL | Hyperdrive | automatic for `pg` / `mysql` in `void.config.ts` | `guide/database.md` | verified |
| Vector search | Vectorize | pass-through via `cloudflare:` in `void.config.ts` | https://developers.cloudflare.com/vectorize/ | unverified: read docs first |
| Multi-step durable jobs | Workflows | may leave Void | https://developers.cloudflare.com/workflows/ | unverified: read docs first |
| Stateful agents | Agents SDK | may leave Void | https://developers.cloudflare.com/agents/ | unverified: read docs first |
| Raw containers | Containers | may leave Void; try `void/sandbox` first | https://developers.cloudflare.com/containers/ | unverified: read docs first |
| Headless browser | Browser Rendering | may leave Void | https://developers.cloudflare.com/browser-rendering/ | unverified: read docs first |
| Image transforms | Images | may leave Void | https://developers.cloudflare.com/images/ | unverified: read docs first |
| Event analytics | Analytics Engine | may leave Void | https://developers.cloudflare.com/analytics/analytics-engine/ | unverified: read docs first |
| Analytics on R2 Iceberg | Basin | may leave Void | https://developers.cloudflare.com/ | unverified: read docs first |
| Bot checks | Turnstile | no binding: client widget plus server Siteverify call | https://developers.cloudflare.com/turnstile/ | unverified: read docs first |

Cloudflare docs search: the `cloudflare-docs` MCP server in `.mcp.json` (https://docs.mcp.cloudflare.com/mcp).
