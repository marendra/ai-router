# Gruuvix AI Router Handoff

Living document — update after every meaningful phase. Another agent must be able to continue
from this file alone.

## Goal

Build a production-oriented OpenAI-compatible AI routing service ("Gruuvix AI Router") on
Cloudflare Workers + one SQLite-backed Durable Object. Gruuvix calls the router with the
official OpenAI SDK for logical model `gpt-oss-120b`; the router performs health-aware
round-robin selection, atomic lease-based concurrency limiting, failure classification,
failover (never before-stream replay after bytes flowed), transparent SSE streaming, and
admin-managed provider configuration across DeepInfra, AkashML and the EXISTING Modal
GPT-OSS-120B endpoint (Modal is consumed, never redeployed).

## Current Architecture

As specified in `docs/AI_ROUTER_ARCHITECTURE.md` (authoritative). Worker = HTTP + streaming
proxy; DO = coordination only (registry, state, leases, cursor); one generic OpenAI-compatible
upstream adapter; secrets only as Cloudflare env bindings referenced by name.

## Current Phase

IMPLEMENTED, DEPLOYED & LIVE-VERIFIED at https://gruuvix-ai-router.marendra.workers.dev
(env `production`, secrets from the account-level Secrets Store). ACTIVE 3-PROVIDER ROUND
ROBIN VERIFIED LIVE (seed v7, 2026-09-20): three consecutive requests hit akashml, crusoe
and deepinfra — each on attempt 1, no failover needed. Default `reasoning_effort=low`
injected upstream (var DEFAULT_REASONING_EFFORT; client value wins). Modal disabled.

## Implementation Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Docs: `docs/AI_ROUTER_ARCHITECTURE.md`, `HANDOFF.md` | DONE |
| 2 | Worker foundation: auth, errors, `/v1/models`, `/health`, `/ready`, request ids, logging | DONE |
| 3 | DO coordinator: registry (SQLite seed + admin CRUD), persistent cursor, runtime state, leases, concurrency | DONE |
| 4 | Generic provider proxy: model rewrite, secrets, timeouts, client cancellation | DONE |
| 5 | Failover + circuit breaker: classification, cooldowns, half-open, attempt exclusion | DONE |
| 6 | Streaming: SSE passthrough, pre-stream failover, no post-stream replay, interruption reporting | DONE |
| 7 | Admin/provider management: status + CRUD under `GRUVIX_AI_ROUTER_ADMIN_KEY` | DONE |
| 8 | Tests: 24 required scenarios + unit tests, all on fake upstreams (vitest-pool-workers) | DONE |
| 9 | Smoke script (`npm run smoke`, OpenAI SDK) + deployment docs (below + README) | DONE |
| 10 | Usage ledger: D1 row per provider attempt (tokens in/out, latency, status), async via ctx.waitUntil | DONE — live-verified |

## Files Created

```
docs/AI_ROUTER_ARCHITECTURE.md      architecture (authoritative design doc)
HANDOFF.md                          this file
README.md                           quickstart + deploy instructions
package.json                        scripts: dev/deploy/typecheck/lint/test/build/smoke
tsconfig.json                       strict TypeScript, workers-types + vitest-pool-workers types
wrangler.jsonc                      DO binding AI_ROUTER, sqlite migration v1, vars, secret docs
vitest.config.ts                    @cloudflare/vitest-pool-workers over wrangler.jsonc
.dev.vars.example                   local secret template (no real values, ever)
src/index.ts                        Worker entry: request-id, routing table, error envelope
src/types/provider.ts               ProviderConfig, ProviderRuntimeState, Lease types
src/types/router.ts                 RPC payload/result types, FailureClass
src/types/openai.ts                 minimal OpenAI request/error shapes
src/config/env.ts                   Env interface (bindings, vars, dynamic secret lookup)
src/config/defaults.ts              logical model + DEFAULT_PROVIDER_SEED (verify before deploy)
src/utils/errors.ts                 OpenAI-shaped error helpers
src/utils/requestId.ts              request-id creation/honoring
src/utils/logging.ts                structured metadata-only logging
src/utils/urls.ts                   base-url + path joining (no /v1/v1)
src/utils/security.ts               timing-safe string compare
src/auth/routerAuth.ts              GRUVIX_AI_ROUTER_KEY bearer check
src/auth/adminAuth.ts               GRUVIX_AI_ROUTER_ADMIN_KEY bearer check
src/router/failureClassifier.ts     status/exception -> FailureClass, failover policy
src/router/providerState.ts         eligibility rules, derived half-open, snapshot shaping
src/router/leaseManager.ts          lease SQL helpers (grant, release, purge, count)
src/providers/providerRegistry.ts   seed + non-secret config resolution
src/providers/openAiCompatibleProvider.ts  ONE generic upstream adapter (fetch, headers, TTFB timeout)
src/durableObjects/AiRouterCoordinator.ts  DO: all coordination RPCs, SQLite persistence
src/routes/chatCompletions.ts       attempt loop: acquire → call → report; failover policy
src/routes/streaming.ts             SSE pipe, idle watchdog, abort handling, stream reporting
src/routes/models.ts                GET /v1/models (logical model only)
src/routes/health.ts                GET /health
src/routes/ready.ts                 GET /ready (DO-backed readiness)
src/routes/internalProviders.ts     admin: GET/POST/PATCH/DELETE /internal/providers
scripts/smoke-router.ts             manual live smoke via official OpenAI SDK (never in CI)
scripts/tsconfig.json               node-types config for the smoke script
schema.sql                          D1 schema for the usage ledger (provider_calls)
src/usage/usageLedger.ts            async D1 recorder + usage extraction (JSON + SSE tail scan)
src/routes/usageQuery.ts            GET /v1/usage — date-range aggregates over the ledger (router-key auth)
test/usageQuery.test.ts             range parsing + endpoint auth/degradation tests
test/usage.test.ts                  usage extraction unit tests (ledger write is production-only)
test/helpers.ts                     fetchMock fake-provider helpers, DO stub factory
test/unit.test.ts                   classifier, url join, request-id, timing-safe compare
test/auth.test.ts                   T18 router auth, T19 admin auth
test/routing.test.ts                T1 round robin, T3 disabled, T4 concurrency, T20 model rewrite, T21 no-repeat
test/state.test.ts                  T2 persistence, T5 lease expiry, T6 idempotent release, T24 load + metrics
test/failover.test.ts               T7 429, T8 500, T9 timeout, T10 402, T11 401, T12 400 passthrough, T22 all down
test/circuit.test.ts                T13 cooldown skip + recovery eligibility, T14 half-open single probe
test/streaming.test.ts              T15 SSE passthrough, T16 pre-stream failover, T17 interruption, T23 client abort
```

## Files Modified

None outside this project (repository was empty when work started; it now lives at
https://github.com/marendra/ai-router.git).

## Important Design Decisions

1. **DO never proxies payloads.** acquire/report RPCs carry only routing metadata; the Worker
   streams provider bytes straight to Gruuvix.
2. **SQLite is the only source of state.** Every RPC re-reads state; no authoritative in-memory
   fields, so hibernation/eviction is a non-event. Cursor, state, leases all survive.
3. **Atomic acquire without locks.** DO inputs are serialized; `acquireProvider` runs
   read→insert→cursor-update with zero awaits inside, so concurrent requests cannot overbook a
   provider.
4. **Active concurrency is derived** from `COUNT(unexpired leases)` — no driftable counters.
   Leases expire (lazy purge at RPC start; no alarms) so crashed Workers cannot leak capacity.
5. **half_open is derived** (`status='cooldown' AND now ≥ cooldown_until`), with
   `half_open_probe_active=1` granting exactly one probe; success → healthy, failure → new
   cooldown.
6. **Class-specific cooldowns**: `authentication_error` (401/403) and `credit_error` (402) get
   long dedicated cooldowns and still fail over; 400/422 (`client_error`) release the lease
   WITHOUT penalty and pass the upstream error through to the client untouched.
7. **Upstream 404 is a provider failure** (`model_configuration_error`): a wrong endpoint/model
   is the provider's config being broken, not Gruuvix's fault → fail over + cooldown.
8. **Config vs state separation**: `providers` table = admin-editable non-secret config;
   `provider_state` = runtime health. Config edits never touch leases; delete with active
   leases flips `pending_deletion=1` until drained.
9. **Secrets by name only**: config stores `api_key_env` / `base_url_env`; Worker resolves
   `env[name]` per request. No secret ever enters SQLite, logs, or API responses. Missing key ⇒
   treated as `authentication_error` (fail over + long cooldown) with a safe validation message.
10. **Timeout semantics** (documented per spec): `timeout_ms` = time-to-first-response
    (AbortSignal on the fetch, i.e. connect + headers); once streaming, only
    `stream_idle_timeout_ms` of inactivity kills a stream — long healthy streams are never
    timed out.
11. **Modal specifics**: no `apiKeyEnv` required (auth optional); larger `timeoutMs` for cold
    starts; base URL via `MODAL_BASE_URL` env (set once, editable) — the existing endpoint is a
    configured upstream, nothing Modal-side is created or changed.
12. **Debug headers** (`x-gruuvix-provider|attempts|request-id`) only when
    `ROUTER_DEBUG_HEADERS` is truthy; production default hides providers. `x-request-id` is
    always set.
13. **Streaming reporting**: success is reported at clean stream end (keeps `activeRequests`
    honest for long generations); mid-stream death reports `stream_interrupted` and terminates —
    never a second provider.

## Tests Performed

- `npm run typecheck` → `npx tsc --noEmit` (strict). Result: **0 errors**.
- `npm test` → `npx vitest run` (via @cloudflare/vitest-pool-workers, workerd runtime,
  all upstream fetches mocked). Result: **7 files, 36 tests, 36 passed, 0 failed**.
  Covers all 24 required scenarios plus unit tests of the classifier, URL joining,
  request-id handling and timing-safe compare.
- `npm run build` → `wrangler deploy --dry-run`. Result: bundle 67.67 KiB / gzip 15.95 KiB,
  Durable Object binding `AI_ROUTER` + vars validated.

## Test Results

```
 npx tsc --noEmit                         → (no output, exit 0)
 npx vitest run
   ✓ test/unit.test.ts (9 tests)
   ✓ test/auth.test.ts (4 tests)
   ✓ test/routing.test.ts (5 tests)
   ✓ test/streaming.test.ts (4 tests)
   ✓ test/state.test.ts (4 tests)
   ✓ test/circuit.test.ts (2 tests)
   ✓ test/failover.test.ts (8 tests)
   Test Files  7 passed (7)
   Tests      36 passed (36)
 npm run build  (wrangler deploy --dry-run)
   Total Upload: 67.67 KiB / gzip: 15.95 KiB   --dry-run: exiting now.
```

NOT tested (no fake or real provider was contacted for these):
- (fake-provider suite) nothing — all 24 required scenarios are covered.

LIVE smoke (2026-09-20, deployed worker, tiny completions, max_tokens ≤ 16):
- auth via Secrets Store key: PASS (401 without/with wrong key, 200 with key)
- GET /ready: PASS → {"status":"ready","servableProviders":["akashml","crusoe","deepinfra"]}
- non-streaming completions: PASS — every request 200; crusoe AND deepinfra both served
  real completions; failover absorbed akashml 530, modal 503 and one transient deepinfra 500
- streaming (SSE passthrough): PASS — text/event-stream chunks forwarded verbatim
- `npm run smoke` (official OpenAI SDK vs production): PASS 4/4 — models, non-streaming,
  streaming (10 chunks), 3 concurrent completions → crusoe/deepinfra/akashml, attempt=1 each
- NOT verified live: modal (disabled), client-abort/stream-interrupt against real upstreams.

## Problems Found

- @cloudflare/vitest-pool-workers 0.22 (latest, 2026-09) REMOVED the classic
  `fetchMock` export from `cloudflare:test`. Pinned `@cloudflare/vitest-pool-workers@0.10`
  + `vitest@3.2` where `fetchMock` is the documented API.
- undici MockAgent interceptors are SINGLE-USE by default: a provider's second request in
  one test failed with `network_error` at 0ms. Fixed with `.persist()` in test helpers.
- The undici `delay` reply option was not honored by the bundled version — moved delays
  into async reply functions (needed for the timeout-failover test).
- An upstream stream that errors SYNCHRONOUSLY (in `start()`) drops queued chunks when
  the pipe aborts, so interruption tests must emit chunks over time (timed source).
- auth (401/403), credit (402) and model-config (404) faults are deterministic, so the DO
  trips their (long) cooldown on the FIRST occurrence; transient classes honor
  `failureThreshold`. Implemented in `AiRouterCoordinator.reportFailure`.
- Cloudflare Secrets Store bindings are NOT strings: `env.NAME` is `{ get(): Promise<string> }`.
  `resolveSecret()` in `src/config/env.ts` handles both forms; auth/readiness/config
  resolution is async accordingly.
- `secrets_store_secrets` live under the `production` env in wrangler.jsonc (deploy with
  `npm run deploy` → `wrangler deploy --env production`). Top-level (default) env keeps
  plain bindings for tests/`wrangler dev`. CAUTION: wrangler environments do NOT inherit
  `vars`/bindings — env.production redeclares vars + the AI_ROUTER DO binding.
- Live-only bug the fake-provider suite could NOT catch: `waitUntil: ctx.waitUntil`
  (destructured) throws "Illegal invocation" in production; must wrap:
  `(p) => ctx.waitUntil(p)`.
- `DEFAULT_SEED_VERSION` (src/config/defaults.ts): bumping it re-asserts default provider
  config onto the live DO and resets those providers' breaker state (config-fix recovery).
  Live DO is at seed version 4.
- Live upstream findings: akashml answers HTTP 530 (edge-level; endpoint/key to verify),
  modal answers HTTP 503 (app not serving — start/verify the Modal app); deepinfra healthy.
- **RESOLVED — akashml 530 root cause**: api.akash.network lost its DNS record (AkashML
  migrated to akashml.com). Seed v7 → `https://api.akashml.com/v1`; key works there.
- **Usage ledger**: chose D1 over R2 on cost (D1 ≈ $1/1M writes, queryable SQL vs R2
  $4.50/1M PUTs, download-to-analyze). Non-streaming: body buffered once for usage
  extraction, re-emitted verbatim. Streaming: `body.tee()` — client branch untouched,
  background branch drains the final usage chunk (requires `stream_options.include_usage`,
  injected automatically). Ledger lives ONLY in env.production; tests/local run without
  the binding (recorder is a no-op — local D1 stub in the vitest pool crashes on these
  writes with workerd "internal error").
- Verified live in D1: non-streaming AND streaming rows with prompt/completion/total
  tokens, latency_ms, finish_reason (e.g. deepinfra stream row: 68/25/93, 1057ms, stop).

## External Review Fixes (2026-09-20, all 7 findings verified then fixed)

1. [P1] **half-open probe wedge**: probe flag cleared on EVERY release path —
   reportFailure clears it before the non-penalizing early-return; housekeeping clears
   stale flags for providers with no live leases; reportSuccess on an expired lease
   still marks healthy. Regression tests R1a/R1b.
2. [P1] **timeout killed healthy streams**: fetch now uses one AbortController per
   attempt; the timeout timer is CLEARED once headers arrive for streaming (TTFB-only
   semantics — idle watchdog governs the body). Non-streaming keeps a total timeout
   through the body read. (R2 test guards the healthy path; the header/body split is
   verified by inspection — the mock cannot deliver a slow body after fast headers.)
3. [P1] **client abort left upstream generating**: tee() removed entirely — the pump
   forwards bytes AND harvests usage from the single stream, so reader.cancel() stops
   the upstream fetch. R3 test asserts the source's cancel() fires.
4. [P1] **stalls reported as success**: watchdog sets an explicit timedOut flag;
   stalled streams terminate with writer.abort() (client sees truncation) and report
   failure class "timeout". R4 test.
5. [P2] **client abort ignored pre-headers**: req.signal wired into the attempt's
   AbortController + explicit req.signal.aborted check before every attempt.
6. [P2] **router 500 on bad 2xx bodies**: body-read failure now reports failure and
   fails over (nothing sent to client yet); JSON-parse failure records empty usage but
   still passes the raw body through with 200. R6 test.
7. [P2] **usage rows lied about interrupted streams**: ledger row now written at stream
   SETTLEMENT (onSettled) with final outcome — failure class + full-stream latency.
   drainSseAndRecord (swallowing errors on a tee branch) deleted.

## Known Limitations

- Single logical model (`gpt-oss-120b`); multi-model works structurally (`getByName(model)`)
  but seeds/routes currently assume the one model.
- Round robin is uniform; weighted/latency/cost strategies are future work (selection is
  isolated, but no weights in config yet).
- Latency statistics: only `last_success_at` / last latency are stored; no rolling percentiles
  in the DO (load-test percentiles are computed in tests).
- `/ready` counts enabled providers with resolvable secrets, ignoring transient cooldowns (a
  brief all-cooldown window still reports ready).
- No persistent request audit log in the DO (logs go to Workers observability only).
- Admin API has no CSRF concern (bearer-only) but also no rate limiting; protect the route at
  the edge if exposed publicly.

export const DEFAULT_SEED_VERSION = 10; // see src/config/defaults.ts (current: novita added)

## Novita addition (2026-09-22, seed v8→v10)

- Provider `novita`: base `https://api.novita.ai/v3/openai`, model id
  **`openai/gpt-oss-120b`** (prefixed), key `NOVITA_API_KEY` (Secrets Store, bound in
  env.production). Two seed fixes were needed: `/openai` path 404'd (correct root is
  `/v3/openai`) and the unprefixed model id 404'd (Novita uses the `openai/` prefix).
  Diagnosed via unauthenticated path probes (403 auth-gate vs 404 no-route) + ledger rows.
- Smoke verified: 4 distinct prompts × 2 rounds, all 200s; Novita served its rotation
  share with usage rows recorded (first call ~45s cold start, then ~3.7s).
- Rotation is now 4 providers: akashml, crusoe, deepinfra, novita. Modal still disabled.

## Failure analytics (2026-09-23)

- `/v1/usage` additionally returns `failureClasses` (provider × class × status counts),
  `recentFailures` (last 20 with UTC timestamps), and per-day `failures` counts in
  `daily`/`providers` rows. Failed attempts were already ledger rows (status, class,
  full-stream latency) — this surfaces them.
- Dashboard: red per-day failure bar chart on each provider card (own scale), failures
  column (highlighted when > 0) in the day and summary tables, a "Failures by cause"
  breakdown, and a "Recent failures" feed with timestamps.

## Remaining Work

- **RESOLVED — AkashML root cause** (seed v7): `api.akash.network` lost its DNS record —
  AkashML migrated to their own domain (old host 301s to akashml.com). akashml now points
  at `https://api.akashml.com/v1`; verified live: key works, serves 200, rotates.
- **Modal**: disabled since seed v5 (instant 503s — app down, not cold start). Re-enable
  via admin API (`PATCH /internal/providers/modal {"enabled":true}`) once persistently
  redeployed.
- **Crusoe** live since seed v6: `https://api.inference.crusoecloud.com/v1`,
  `openai/gpt-oss-120b`, `CRUSOE_API_KEY` (Secrets Store).
- Default `reasoning_effort=low` injected upstream unless the client sends one (var
  `DEFAULT_REASONING_EFFORT`).
- Optional future: weighted routing, per-provider RPM quotas, multiple logical models,
  latency EWMA in selection, rolling error-rate metrics endpoint.

## Recommended Next Step

Verify/fix the AkashML endpoint+key, then run
`GRUVIX_AI_ROUTER_URL=https://gruuvix-ai-router.marendra.workers.dev GRUVIX_AI_ROUTER_KEY=<key> npm run smoke`
and confirm rotation (enable ROUTER_DEBUG_HEADERS=true temporarily in env.production to
see x-gruuvix-provider per response).
