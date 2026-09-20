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

```bash
wrangler login
wrangler secret put GRUVIX_AI_ROUTER_KEY
wrangler secret put GRUVIX_AI_ROUTER_ADMIN_KEY
wrangler secret put DEEPINFRA_API_KEY
wrangler secret put AKASHML_API_KEY
wrangler secret put MODAL_BASE_URL      # existing Modal GPT-OSS-120B endpoint (consumed, not redeployed)
# optional, only if the Modal endpoint enforces auth:
wrangler secret put MODAL_API_KEY
npm run deploy
```

Verify the seeded provider base URLs / model ids in `src/config/defaults.ts` (or via the
admin API) before first deploy — they are initial defaults, not guessed production values.

## Smoke (manual, spends a tiny amount)

```bash
GRUVIX_AI_ROUTER_URL=https://gruuvix-ai-router.<account>.workers.dev \
GRUVIX_AI_ROUTER_KEY=... npm run smoke
```
