## Cloudflare routing (Void 1.11.0)

Rules, in order:

1. Before any Cloudflare work, read `node_modules/void/docs/` and the table below. Only then consider raw Wrangler config.
2. Containers or sandbox requests: look at `void/sandbox` first (needs Workers Paid and Docker).
3. Brownfield `@cloudflare/vite-plugin` apps: use Void's `migrate-vite-cloudflare-to-void` skill.
4. Never create wrangler files. Void migrates a root `wrangler.jsonc` into `void.config.ts` itself. Extra bindings go under `cloudflare:` in `void.config.ts`.

Table checked against the `void@1.11.0` package docs (the `CREATE_VOID` pin; this repo has no `void` install, so read them with `npm pack void@<pin>`). Void docs links are https://void.cloud/<path>; the same pages ship in `node_modules/void/docs/` (a `.md` file per path). Status `unverified: read docs first` means not confirmed against the package docs: read the linked docs before using it. Read this table before saying Void does or doesn't cover something.

Inferred bindings (`DB`, `KV`, `STORAGE`, `AI`, `QUEUE_*`, Durable Objects) are detected from imports and provisioned by `void deploy` (reference/resource-inference). Any other Cloudflare binding is a pass-through: declare it under `cloudflare:` in `void.config.ts` (any Wrangler field is passed through, typed on `c.env` after `void prepare`), and you create the resource yourself.

| Need | Product | Void module or pass-through | Docs | Status |
| --- | --- | --- | --- | --- |
| HTTP API, middleware | Workers | `void/handler`, `routes/`, `middleware/` | https://void.cloud/reference/structure | verified |
| Pages, static files | Static assets | `pages/`, `public/` | https://void.cloud/reference/structure | verified |
| SQL database | D1 | `void/db`, `void/schema-d1`, `void/seed`, `void db` | https://void.cloud/guide/database | verified |
| Key-value cache | KV | `void/kv` | https://void.cloud/guide/kv | verified |
| Files, blobs | R2 | `void/storage` | https://void.cloud/guide/storage | verified |
| Realtime, coordination, per-key state | Durable Objects | `void/durable`, `durable-objects/` | https://void.cloud/guide/durable-state | verified |
| Background jobs | Queues | `queues/`, `void/queues`; consumer settings are exported constants (`maxBatchSize`, `maxBatchTimeout`, `maxConcurrency`, `maxRetries`, `retryDelay`); no dead-letter queue, so messages that exhaust retries are deleted: record failure in D1 on the last attempt | https://void.cloud/guide/queues | verified |
| Bulk or marketing email | another provider (e.g. SES) | `void/email` is transactional only (default platform allowance 200 recipients/month, 50 per message); call the provider from a handler or queue consumer | https://void.cloud/guide/email/sending | verified |
| Run untrusted code, containers | Sandbox (Containers) | `void/sandbox` (Workers Paid and Docker) | https://void.cloud/guide/sandboxes | verified |
| LLM inference | Workers AI, AI Gateway | `void/ai` | https://void.cloud/guide/ai | verified |
| Send or receive email | Email | `void/email`, `email/` | https://void.cloud/guide/email/sending, https://void.cloud/guide/email/receiving | verified |
| Scheduled jobs | Cron Triggers | `crons/` | https://void.cloud/reference/structure | verified |
| Config and secrets | Env, secrets | `env.ts`, `void/env`, root `.env`, `void secret put` | https://void.cloud/guide/env-vars | verified |
| Sign-in, sessions | Auth | `void/auth` | https://void.cloud/guide/auth | verified |
| Postgres or MySQL | Hyperdrive | automatic for `pg` / `mysql` in `void.config.ts` | https://void.cloud/guide/database | verified |
| Custom domains | Workers custom domains | `void domain add <host>` (direct deploys: one `custom_domain` route per host; no wildcards) | https://void.cloud/reference/cli/domains | verified |
| Per-customer hostnames | Cloudflare for SaaS | hosted Void platform only (needs a dedicated application zone); direct deploys have no SaaS hostnames | https://void.cloud/guide/platform/installation/domains | verified |
| Visitor geo (country, colo) | `request.cf` | `c.req.raw.cf` in a handler (Void's own auth reads `request.cf`; not covered in Void docs) | https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties | verified in runtime source |
| Rate limiting | Rate Limiting binding | pass-through via `cloudflare: { ratelimits: [...] }` | https://void.cloud/guide/type-safety | verified |
| Vector search | Vectorize | pass-through via `cloudflare:` in `void.config.ts` | https://developers.cloudflare.com/vectorize/ | verified (pass-through; not provisioned) |
| Multi-step durable jobs | Workflows | may leave Void | https://developers.cloudflare.com/workflows/ | unverified: read docs first |
| Stateful agents | Agents SDK | may leave Void | https://developers.cloudflare.com/agents/ | unverified: read docs first |
| Raw containers | Containers | may leave Void; try `void/sandbox` first | https://developers.cloudflare.com/containers/ | unverified: read docs first |
| Headless browser | Browser Rendering | pass-through via `cloudflare: { browser: ... }` | https://developers.cloudflare.com/browser-rendering/ | verified (pass-through; not provisioned) |
| Image transforms | Images | pass-through via `cloudflare: { images: ... }` | https://developers.cloudflare.com/images/ | verified (pass-through; not provisioned) |
| Event analytics | Analytics Engine | pass-through via `cloudflare: { analytics_engine_datasets: [...] }` (account must enable Analytics Engine) | https://developers.cloudflare.com/analytics/analytics-engine/ | verified (pass-through; not provisioned) |
| Analytics on R2 Iceberg | Basin | may leave Void | https://developers.cloudflare.com/ | unverified: read docs first |
| Bot checks | Turnstile | no binding: client widget plus server Siteverify call; zero-stack's `--turnstile` installs both | https://developers.cloudflare.com/turnstile/ | verified (zero-stack installer) |

Cloudflare docs search: the `cloudflare-docs` MCP server in `.mcp.json` (https://docs.mcp.cloudflare.com/mcp).
