# Gruuvix AI Router

OpenAI-compatible AI routing service on Cloudflare Workers. Gruuvix calls ONE endpoint for
`gpt-oss-120b`; the router picks DeepInfra / AkashML / the existing Modal endpoint with
health-aware round robin, leases, concurrency limits, failover and transparent SSE
streaming. Gruuvix never knows or needs to know which provider answered.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GRUVIX_AI_ROUTER_KEY,
  baseURL: process.env.GRUVIX_AI_ROUTER_URL + "/v1",
});

const res = await client.chat.completions.create({
  model: "gpt-oss-120b",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Layout

- `docs/AI_ROUTER_ARCHITECTURE.md` — authoritative design document
- `docs/TEAM_API_GUIDE.md` — **start here to integrate**: base URL, auth, SDK examples, usage queries, error handling
- `HANDOFF.md` — living status/handoff (update after every phase)
- `src/` — Worker, routes, Durable Object coordinator, router logic, providers, auth
- `test/` — vitest-pool-workers suite; every upstream is mocked, no paid calls ever
- `scripts/smoke-router.ts` — manual live smoke via the official OpenAI SDK

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest via @cloudflare/vitest-pool-workers (mocked upstreams)
npm run build       # wrangler deploy --dry-run
npm run dev         # local dev (needs .dev.vars — copy .dev.vars.example)
```

## Deploy (explicitly only — never automatic)

`npm run deploy` runs `wrangler deploy --env production`, which binds the account-level
**Secrets Store** secrets declared in `wrangler.jsonc` (store `default_secrets_store`):
`GRUVIX_AI_ROUTER_KEY`, `GRUVIX_AI_ROUTER_ADMIN_KEY`, `DEEPINFRA_API_KEY`,
`AKASHML_API_KEY`, `MODAL_BASE_URL`, `MODAL_API_KEY`. Create/update those in the
dashboard (Workers → Secrets Store) — values are write-only there, which is the point.

Notes:
- wrangler environments do NOT inherit vars/bindings: `env.production` redeclares the
  vars and the `AI_ROUTER` Durable Object binding. Keep both in sync if you add more.
- Alternative (per-worker secrets instead of the store): `npx wrangler secret put <NAME>`
  for each — the code accepts both (plain strings and store bindings).
- Local dev uses `.dev.vars` (copy `.dev.vars.example`) with the default environment.

```bash
wrangler login
npm run deploy
```

Verify the seeded provider base URLs / model ids in `src/config/defaults.ts` (or via the
admin API) before first deploy — they are initial defaults, not guessed production values.

## Usage analytics (D1)

Every provider attempt is logged asynchronously to D1 (`gruuvix-usage.provider_calls`):
tokens in/out, duration, status, failure class — never prompt/completion text.

**Query endpoint** (same router key as inference):

```bash
curl -H "Authorization: Bearer $GRUVIX_AI_ROUTER_KEY" \
  "https://gruuvix-ai-router.marendra.workers.dev/v1/usage?from=2026-09-20&to=2026-09-20"
# optional: &provider=deepinfra  (from/to accept YYYY-MM-DD or ISO datetime; to inclusive; max 92 days)
```

Returns totals, per-provider aggregates (calls, ok_calls, tokens in/out, avg/max latency)
and a per-day breakdown.

```bash
# raw SQL also works — tokens + latency per provider, per day
npx wrangler d1 execute gruuvix-usage --remote --command "
  SELECT provider, date(ts/1000,'unixepoch') AS day,
         COUNT(*) AS calls,
         SUM(prompt_tokens) AS tokens_in,
         SUM(completion_tokens) AS tokens_out,
         CAST(AVG(latency_ms) AS INT) AS avg_ms
  FROM provider_calls GROUP BY provider, day ORDER BY day DESC, provider"
```

Chosen over R2 JSON dumps on cost: D1 ≈ $1 per 1M row writes (50M/month included on
Workers Paid) and directly queryable; R2 PUTs cost $4.50 per 1M and would need
download-and-parse for every question.

## Smoke (manual, spends a tiny amount)

```bash
GRUVIX_AI_ROUTER_URL=https://gruuvix-ai-router.<account>.workers.dev \
GRUVIX_AI_ROUTER_KEY=... npm run smoke
```
