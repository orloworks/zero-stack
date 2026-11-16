## Cloudflare routing (Void 1.8.0)

Rules, in order:

1. Before any Cloudflare work, read `node_modules/void/docs/` and the table below. Only then consider raw Wrangler config.
2. Containers or sandbox requests: look at `void/sandbox` first (needs Workers Paid and Docker).
3. Brownfield `@cloudflare/vite-plugin` apps: use Void's `migrate-vite-cloudflare-to-void` skill.
4. Never create wrangler files. Void migrates a root `wrangler.jsonc` into `void.config.ts` itself. Extra bindings go under `cloudflare:` in `void.config.ts`.

Table checked against the `void@1.8.0` package docs. Void docs links are https://void.cloud/<path>; the same pages ship in `node_modules/void/docs/` (a `.md` file per path). Status `unverified: read docs first` means not confirmed against the package docs: read the linked docs before using it.

| Need | Product | Void module or pass-through | Docs | Status |
| --- | --- | --- | --- | --- |
| HTTP API, middleware | Workers | `void/handler`, `routes/`, `middleware/` | https://void.cloud/reference/structure | verified |
| Pages, static files | Static assets | `pages/`, `public/` | https://void.cloud/reference/structure | verified |
| SQL database | D1 | `void/db`, `void/schema-d1`, `void/seed`, `void db` | https://void.cloud/guide/database | verified |
| Key-value cache | KV | `void/kv` | https://void.cloud/guide/kv | verified |
| Files, blobs | R2 | `void/storage` | https://void.cloud/guide/storage | verified |
| Realtime, coordination, per-key state | Durable Objects | `void/durable`, `durable-objects/` | https://void.cloud/guide/durable-state | verified |
| Background jobs | Queues | `queues/`, `void/queues` | https://void.cloud/guide/queues | verified |
| Run untrusted code, containers | Sandbox (Containers) | `void/sandbox` (Workers Paid and Docker) | https://void.cloud/guide/sandboxes | verified |
| LLM inference | Workers AI, AI Gateway | `void/ai` | https://void.cloud/guide/ai | verified |
| Send or receive email | Email | `void/email`, `email/` | https://void.cloud/guide/email/sending, https://void.cloud/guide/email/receiving | verified |
| Scheduled jobs | Cron Triggers | `crons/` | https://void.cloud/reference/structure | verified |
| Config and secrets | Env, secrets | `env.ts`, `void/env`, root `.env`, `void secret put` | https://void.cloud/guide/env-vars | verified |
| Sign-in, sessions | Auth | `void/auth` | https://void.cloud/guide/auth | verified |
| Postgres or MySQL | Hyperdrive | automatic for `pg` / `mysql` in `void.config.ts` | https://void.cloud/guide/database | verified |
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
