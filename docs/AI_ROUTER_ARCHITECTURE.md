# Gruuvix AI Router — Architecture

Status: living document. Update when the implementation diverges from this description.

## 1. Purpose

Gruuvix needs to call `gpt-oss-120b`. Instead of Gruuvix knowing about individual inference
providers, it calls ONE OpenAI-compatible service: the **Gruuvix AI Router**.

```
Gruuvix (OpenAI SDK)
    |
    v
Gruuvix AI Router  (Cloudflare Worker)
    |
    +---- DeepInfra   (OpenAI-compatible, API key)
    +---- AkashML     (OpenAI-compatible, API key)
    +---- Modal       (EXISTING GPT-OSS-120B endpoint, auth optional)
    +---- future OpenAI-compatible providers
```

From Gruuvix's point of view the router **is** an OpenAI API for the logical model
`gpt-oss-120b`. Provider selection, failover, health tracking and concurrency limits are
entirely internal. Gruuvix never sees provider ids and never retries itself.

## 2. Components

| Component | Runtime | Responsibility |
|---|---|---|
| `src/index.ts` | Worker | HTTP entry, request id, routing table, top-level error handling |
| `src/routes/*` | Worker | `/v1/chat/completions`, `/v1/models`, `/health`, `/ready`, `/internal/providers*` |
| `src/durableObjects/AiRouterCoordinator.ts` | Durable Object (SQLite) | Routing coordination ONLY: provider registry, runtime state, leases, cursor |
| `src/router/*` | Worker + DO | Failure classification, selection algorithm, lease helpers, eligibility rules |
| `src/providers/openAiCompatibleProvider.ts` | Worker | ONE generic upstream adapter (fetch, model rewrite, auth header, timeout) |
| `src/config/defaults.ts` | both | Logical model + default provider seed (loaded into the DO `providers` table on first access) — the "registry" is the DO table, editable via the admin API |
| `src/auth/*` | Worker | Router bearer auth (Gruuvix) and admin bearer auth (`/internal/*`) |
| `src/config/*` | both | Env typing, defaults, static seed configuration |
| `src/utils/*` | both | Request id, OpenAI-shaped errors, structured logging, URL joining, timing-safe compare |

### The single most important boundary

```
Worker  --acquireProvider()-->  DO   (short RPC: routing metadata only)
Worker  --------------------->  Upstream provider (full LLM request + streaming response)
Worker  --reportSuccess/Failure()-->  DO   (short RPC)
```

**The Durable Object never proxies LLM payload.** It sees only `requestId`, `model`,
`excludeProviderIds` and lease/failure metadata. Generations can run for minutes; the DO is
involved for microseconds.

## 3. Durable Object design (`AiRouterCoordinator`)

One DO instance for the logical model, addressed by name:

```ts
env.AI_ROUTER.getByName("gpt-oss-120b")  // idFromName → same global instance everywhere
```

All state is **SQLite-backed** (`ctx.storage.sql`). In-memory fields are never treated as
authoritative; every RPC reads current state from SQLite, so DO eviction/hibernation loses
nothing.

### 3.1 Schema

```sql
CREATE TABLE IF NOT EXISTS providers (          -- non-secret configuration
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  base_url TEXT,                                -- either base_url or base_url_env must be set
  base_url_env TEXT,                            -- env var NAME holding the base URL (e.g. MODAL_BASE_URL)
  model_id TEXT NOT NULL,                       -- provider-specific upstream model id
  api_key_env TEXT,                             -- env var NAME of the secret; NULL = no auth (Modal)
  timeout_ms INTEGER NOT NULL,                  -- time-to-first-response (HTTP headers) timeout
  stream_idle_timeout_ms INTEGER NOT NULL,      -- inactivity timeout once the stream is flowing
  cooldown_ms INTEGER NOT NULL,                 -- base cooldown after threshold failures
  auth_failure_cooldown_ms INTEGER NOT NULL,    -- long cooldown for 401/403 (config error)
  credit_failure_cooldown_ms INTEGER NOT NULL,  -- long cooldown for 402 (account/credit)
  failure_threshold INTEGER NOT NULL,           -- consecutive failures before cooldown
  max_concurrent_requests INTEGER NOT NULL,
  pending_deletion INTEGER NOT NULL DEFAULT 0,  -- see §3.6
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_state (     -- runtime health, separate from config
  provider_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                         -- 'healthy' | 'cooldown' | 'disabled'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,                       -- epoch ms; status 'half_open' is DERIVED (§3.4)
  half_open_probe_active INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_failure_status INTEGER
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                   -- now + LEASE_TTL_MS
);

CREATE TABLE IF NOT EXISTS router_state (       -- key/value: 'round_robin_cursor'
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Secrets are **never** stored here — providers store the *name* of a Cloudflare secret
(`api_key_env`); the Worker resolves `env[api_key_env]` at request time.

### 3.2 RPC surface

| Method | Purpose |
|---|---|
| `acquireProvider({model, requestId, excludeProviderIds})` | Atomically pick a provider and grant a lease. Returns `{ok:true, providerId, leaseId, expiresAt, config}` or `{ok:false}`. `config` is the non-secret config snapshot the Worker needs to call upstream (saves a second RPC). |
| `reportSuccess({leaseId, providerId, latencyMs})` | Release lease, reset failures, mark healthy, record `last_success_at`. |
| `reportFailure({leaseId, providerId, status, failureClass, latencyMs})` | Release lease, count failure, maybe enter cooldown (class-specific). Non-penalizing classes only release. |
| `listProviders()` / `getSnapshot()` | Safe status for `/internal/providers` and `/ready`. Never includes secrets. |
| `upsertProvider(patch)` / `deleteProvider(id)` | Admin config management (non-secret only). |

### 3.3 Atomicity / race safety

A DO processes inputs one at a time on a single thread; interleaving can only happen across
`await` points. `acquireProvider` performs **all** of its work synchronously — purge expired
leases (one `DELETE`), evaluate eligibility (SQL reads), insert the lease, advance and persist
the cursor — with no `await` between read and write. Two concurrent acquires are therefore
serialized by the DO runtime; the concurrency limit can never be double-booked. No locks or
alarms are needed.

### 3.4 Health model (lightweight circuit breaker)

```
healthy ──(consecutive failures ≥ failure_threshold)──> cooldown (until = now + class cooldown)
cooldown ──(now ≥ cooldown_until)──> half_open  [derived state: exactly ONE probe lease allowed]
half_open ──probe succeeds──> healthy          (failures reset)
half_open ──probe fails───> cooldown           (new cooldown window)
```

- `half_open_probe_active` guarantees a single in-flight probe per provider.
- Class-specific cooldowns: `authentication_error` → `auth_failure_cooldown_ms` (long),
  `credit_error` → `credit_failure_cooldown_ms` (long), everything else → `cooldown_ms`.
- A single transient failure does NOT trip the breaker; `failure_threshold` is configurable
  per provider.
- **Active concurrency is DERIVED from unexpired leases** (`COUNT(leases)` per provider), not
  from an independently mutated counter — counters cannot drift because they don't exist.
- Expired leases are purged lazily at the top of every RPC (no alarms in Phase 1).

### 3.5 Round-robin cursor

`router_state['round_robin_cursor']` stores the index (in the id-sorted provider list) of the
provider selected last. Selection walks the sorted list from `cursor+1`, wraps, skips
ineligible providers (disabled, cooling, at capacity, excluded), selects the first eligible
one, and persists `cursor = selectedIndex`. Persisted on every acquire, so it survives DO
eviction.

### 3.6 Provider lifecycle under admin changes

- **Disable**: no NEW leases; in-flight leases simply expire or report out (requests finish).
- **Update**: safe fields only; in-flight requests keep their copied config snapshot.
- **Delete with active leases**: provider is marked `pending_deletion=1, enabled=0` until its
  unexpired leases drain, then rows are removed. Lease accounting is never orphaned.

## 4. Request flow

### Non-streaming

```
POST /v1/chat/completions (Bearer GRUVIX_AI_ROUTER_KEY)
  → request id (honor x-request-id or generate)
  → validate: body JSON, model == 'gpt-oss-120b', messages array
  → attempt loop (≤ MAX_PROVIDER_ATTEMPTS, never same provider twice):
      DO.acquireProvider(model, requestId, exclude=attempted)
        ├─ none available → 503 no_provider_available
        └─ lease + config snapshot
      resolve secret env[api_key_env] (missing → reportFailure(authentication_error), fail over)
      fetch upstream: rewrite model → provider modelId, fresh Authorization header,
                      AbortSignal.timeout(timeoutMs) [time-to-first-response]
        ├─ 2xx    → reportSuccess, return upstream response verbatim (+x-request-id)
        ├─ 400/422 (client_error) → release lease WITHOUT penalty, return upstream error to client
        ├─ retryable (network, timeout, 402, 408, 429, 5xx, 404-config) → reportFailure, exclude, retry
        └─ non-retryable other → return OpenAI-shaped error
```

Failover classes: `network_error`, `timeout`, `rate_limit` (429), `provider_overloaded`
(500/503/529), `provider_error` (502/504), `credit_error` (402), `authentication_error`
(401/403), `model_configuration_error` (404 from upstream), `stream_interrupted`.
Non-failover: `client_error` (400/422 from upstream — request's fault), `client_abort`.

### Streaming

Same attempt loop, but the failover window ends when the upstream returns 2xx **headers**:

- Upstream non-2xx before any byte forwarded → normal failover (e.g. Modal 503 → DeepInfra).
- Upstream 2xx → Worker returns `Response(upstream.body)` with `Content-Type: text/event-stream`;
  SSE bytes are piped through 1:1, never buffered or re-serialized.
- A watchdog aborts the upstream if no bytes arrive for `stream_idle_timeout_ms` (a long but
  silent generation is not killed; a dead connection is).
- Mid-stream failure after bytes were forwarded → report `stream_interrupted`, **terminate** the
  stream. NEVER replay with another provider (Gruuvix already consumed half a completion).
- Client disconnect → cancel upstream fetch, report `client_abort` (no health penalty).
- Success is reported only when the stream completes cleanly, so `activeRequests` stays honest
  during long generations.

## 5. Security model

- Two separate bearer keys: `GRUVIX_AI_ROUTER_KEY` (data plane) and
  `GRUVIX_AI_ROUTER_ADMIN_KEY` (`/internal/*`). Compared timing-safely; 401 on failure.
- Provider API keys live only in Cloudflare secrets, referenced by name in config.
- The client's `Authorization` header is NEVER forwarded upstream; upstream auth headers are
  constructed from the selected provider's secret.
- Upstream URLs come exclusively from provider configuration. There is no client-supplied
  `baseUrl`/`upstreamUrl` anywhere — the router cannot be abused as an open proxy/SSRF.
- Clients cannot influence provider selection (no `provider=` parameter is honored).
- Nothing about request/response content is ever logged: no prompts, no completions, no keys,
  no Authorization headers. Logs carry ids, statuses, classes, latencies only.
- Upstream error bodies are passed through to the client only for `client_error` (4xx request
  problems). For provider-side failures the router emits its own generic OpenAI-shaped error,
  never the raw upstream body (may contain infrastructure details).

## 6. Configuration

- Static seed: `src/config/defaults.ts` — initial provider definitions (baseUrls/model ids are
  **initial defaults to verify before deploy**, not guessed production values).
- Runtime truth: the DO `providers` table, seeded from defaults on first access, editable via
  admin API without code changes.
- Worker vars (`wrangler.jsonc`): `LOG_LEVEL`, `ROUTER_DEBUG_HEADERS`, `MAX_PROVIDER_ATTEMPTS`,
  `LEASE_TTL_MS`.
- Secrets: `GRUVIX_AI_ROUTER_KEY`, `GRUVIX_AI_ROUTER_ADMIN_KEY`, `DEEPINFRA_API_KEY`,
  `AKASHML_API_KEY`, `MODAL_API_KEY` (optional), `MODAL_BASE_URL` (env-managed URL of the
  existing Modal endpoint).

Per-provider knobs (all in config, none hardcoded in logic): `baseUrl`/`baseUrlEnv`, `modelId`,
`apiKeyEnv?`, `timeoutMs` (Modal gets a larger value for cold starts), `streamIdleTimeoutMs`,
`cooldownMs`, `authFailureCooldownMs`, `creditFailureCooldownMs`, `failureThreshold`,
`maxConcurrentRequests`, `enabled`.

Base URL convention: `${baseUrl}/chat/completions` must be the endpoint (baseUrl may end with
`/v1` or a provider-specific equivalent like `/v1/openai`); trailing slashes are normalized so
`/v1/v1/...` can never happen.

## 7. Extensibility points (deliberately not implemented)

Selection is isolated behind the eligibility+round-robin core in the DO, so later phases can
add weighted/latency/cost-aware routing, per-provider quotas/RPM, warm-cold awareness and
multiple logical models (one DO instance per model already works via `getByName`) without
touching route handlers or the Worker proxy path.

## 8. Testing approach

`@cloudflare/vitest-pool-workers` runs the suite inside workerd. Outbound fetch is mocked with
the pool's `fetchMock` (fake OpenAI-compatible upstreams), so **no test ever touches a paid
provider**. DO RPC is exercised directly through the binding stub. Live smoke testing is a
separate manual script (`npm run smoke`) using the official OpenAI SDK against the deployed
router with tiny completions.
