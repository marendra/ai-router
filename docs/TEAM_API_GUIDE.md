# Gruuvix AI Router — Team API Guide

Everything your team needs to use the AI Router. **One base URL, one API key, one model
name** — the router transparently rotates inference providers (DeepInfra / AkashML /
Crusoe / Novita), handles failures, and tracks token usage.

- **Base URL:** `https://gruuvix-ai-router.marendra.workers.dev`
- **Model name:** `gpt-oss-120b` (the only supported model)
- **Auth:** `Authorization: Bearer <GRUVIX_AI_ROUTER_KEY>` on every request
- **API key value:** ask the admin (it lives in Cloudflare Secrets Store as
  `GRUVIX_AI_ROUTER_KEY` and is also in the project's local `.dev.vars`). Never commit
  or paste it into tickets/chats.

> The router IS an OpenAI-compatible API. Use the official OpenAI SDK and just change
> the `baseURL`. You never need to know or care which provider answered.

---

## 1. Quickstart — TypeScript / JavaScript

```bash
npm install openai
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GRUVIX_AI_ROUTER_KEY,          // the router key
  baseURL: process.env.GRUVIX_AI_ROUTER_URL + "/v1", // https://gruuvix-ai-router.marendra.workers.dev/v1
});

const response = await client.chat.completions.create({
  model: "gpt-oss-120b",
  messages: [{ role: "user", content: "Summarize: The cat sat on the mat all day." }],
  max_tokens: 100,
});

console.log(response.choices[0].message?.content);
```

Recommended `.env` for your service:

```env
GRUVIX_AI_ROUTER_URL=https://gruuvix-ai-router.marendra.workers.dev
GRUVIX_AI_ROUTER_KEY=<ask admin>
```

## 2. Quickstart — Python

```bash
pip install openai
```

```python
from openai import OpenAI
import os

client = OpenAI(
    api_key=os.environ["GRUVIX_AI_ROUTER_KEY"],
    base_url=os.environ["GRUVIX_AI_ROUTER_URL"] + "/v1",
)

response = client.chat.completions.create(
    model="gpt-oss-120b",
    messages=[{"role": "user", "content": "Summarize: The cat sat on the mat all day."}],
    max_tokens=100,
)
print(response.choices[0].message.content)
```

## 3. Quickstart — curl

```bash
curl https://gruuvix-ai-router.marendra.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GRUVIX_AI_ROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss-120b",
    "messages": [{"role": "user", "content": "Summarize: birds fly south in winter."}],
    "max_tokens": 100
  }'
```

## 4. Streaming

Standard OpenAI SSE streaming — works exactly like OpenAI's:

```ts
const stream = await client.chat.completions.create({
  model: "gpt-oss-120b",
  messages: [{ role: "user", content: "Summarize this paragraph..." }],
  max_tokens: 300,
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## 5. Reasoning effort (defaults to low)

gpt-oss-120b is a reasoning model. The router already injects
`reasoning_effort: "low"` into every request — ideal for our summarization workload
(fast and cheap). If a specific call needs deeper reasoning, opt up per request:

```ts
const response = await client.chat.completions.create({
  model: "gpt-oss-120b",
  messages,
  max_tokens: 500,
  // @ts-expect-error — pass-through field supported by the upstream models
  reasoning_effort: "medium", // "low" | "medium" | "high"
});
```

## 6. Check your token usage

The router records tokens in/out, duration and status for every call.

```bash
curl -H "Authorization: Bearer $GRUVIX_AI_ROUTER_KEY" \
  "https://gruuvix-ai-router.marendra.workers.dev/v1/usage?from=2026-09-20&to=2026-09-20"
```

- `from`/`to`: `YYYY-MM-DD` (inclusive) or ISO datetime. Default: last 7 days. Max range: 92 days.
- Optional: `&provider=deepinfra` to scope to one provider.

Response (abridged):

```json
{
  "total": { "calls": 3, "tokens_in": 225, "tokens_out": 73 },
  "providers": [
    { "provider": "deepinfra", "calls": 1, "ok_calls": 1,
      "tokens_in": 68, "tokens_out": 25, "avg_ms": 1057, "max_ms": 1057 },
    { "provider": "crusoe", "calls": 1, "ok_calls": 1,
      "tokens_in": 80, "tokens_out": 24, "avg_ms": 999, "max_ms": 999 }
  ],
  "daily": [ ...per-day breakdown... ]
}
```

## 7. Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v1/models` | List available models (returns `gpt-oss-120b`) |
| `GET /health` | Liveness check (no auth) |
| `GET /ready` | Readiness — which providers are currently serviceable (no auth) |

## 8. Errors & troubleshooting

Errors are OpenAI-shaped:

```json
{ "error": { "message": "...", "type": "...", "code": "..." } }
```

| Status | Code | Meaning | What to do |
|---|---|---|---|
| 400 | `invalid_request_error` | Malformed body / bad usage params | Fix the request |
| 401 | `invalid_api_key` | Missing/wrong router key | Check `GRUVIX_AI_ROUTER_KEY` |
| 404 | `model_not_supported` | Model other than `gpt-oss-120b` | Use `gpt-oss-120b` |
| 502 | `all_providers_failed` | Transient — every provider failed this time | Retry with backoff |
| 503 | `no_provider_available` | No provider has spare capacity right now | Retry with backoff |

Notes:

- **Failover is automatic.** If a provider errors, times out or rate-limits, the router
  retries the same request on the next provider — you just get the final answer. A single
  request never uses the same provider twice.
- **Never retry yourself** on 429/502/503 more than a couple of times with backoff; the
  router already tries every provider per request.
- **Debugging:** every response carries an `x-request-id` header — include it when
  reporting issues.
- **Don't send** provider names, upstream URLs, or `Authorization` values for upstreams —
  routing is server-side only and such fields are ignored/rejected.

## 9. What you should NOT expect (current limits)

- Only `gpt-oss-120b` is served — other model names are rejected.
- No per-key rate limiting yet: keep request volume sane (the providers' own limits
  apply and the router cools down providers that trip them).
- Provider choice per request is not controllable from the client (by design).
