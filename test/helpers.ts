/**
 * Shared test helpers. ALL upstream providers are fake hosts intercepted by the pool's
 * fetchMock — the suite never contacts DeepInfra/AkashML/Modal and never spends money.
 *
 * Each seed run mints UNIQUE fake hosts (`http://<id>-<n>.test/...`) so mocks from one
 * test can never satisfy another test's requests.
 */
import { env, fetchMock } from "cloudflare:test";
import type { AiRouterCoordinator } from "../src/durableObjects/AiRouterCoordinator";
import type { ProviderStatusView } from "../src/types/provider";
import type { AcquireProviderResult } from "../src/types/router";

export const ROUTER_KEY = "test-router-key";
export const ADMIN_KEY = "test-admin-key";

let hostCounter = 0;

export interface SeededProvider {
  enabled: boolean;
  baseUrl: string;
  modelId: string;
}

const BASE_DEFAULTS = {
  timeoutMs: 5_000,
  streamIdleTimeoutMs: 5_000,
  cooldownMs: 1_000,
  authFailureCooldownMs: 10_000,
  creditFailureCooldownMs: 10_000,
  failureThreshold: 2,
  maxConcurrentRequests: 50,
};

export interface FakeProviderSpec {
  enabled?: boolean;
  baseUrl?: string;
  modelId?: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  cooldownMs?: number;
  authFailureCooldownMs?: number;
  creditFailureCooldownMs?: number;
  failureThreshold?: number;
  maxConcurrentRequests?: number;
}

/** Fake base URLs: unique per seed run, keyed by short provider id (a, b, c, ...). */
export async function seedProviders(
  specs: Record<string, FakeProviderSpec>,
): Promise<Record<string, SeededProvider>> {
  hostCounter += 1;
  const run = hostCounter;
  const stub = routerStub();

  // Neutralize the default seed so unlisted providers never interfere.
  const current = await stub.listProviders();
  for (const p of current.providers) {
    await stub.upsertProvider({ id: p.id, enabled: false });
  }

  const seeded: Record<string, SeededProvider> = {};
  for (const [id, spec] of Object.entries(specs)) {
    const baseUrl = spec.baseUrl ?? `http://${id}-${run}.test/v1`;
    const modelId = spec.modelId ?? `fake-model-${id}`;
    const result = await stub.upsertProvider({
      id,
      enabled: spec.enabled ?? true,
      baseUrl,
      modelId,
      apiKeyEnv: null, // tests resolve no secrets; auth comes from the mock
      timeoutMs: spec.timeoutMs ?? BASE_DEFAULTS.timeoutMs,
      streamIdleTimeoutMs: spec.streamIdleTimeoutMs ?? BASE_DEFAULTS.streamIdleTimeoutMs,
      cooldownMs: spec.cooldownMs ?? BASE_DEFAULTS.cooldownMs,
      authFailureCooldownMs: spec.authFailureCooldownMs ?? BASE_DEFAULTS.authFailureCooldownMs,
      creditFailureCooldownMs: spec.creditFailureCooldownMs ?? BASE_DEFAULTS.creditFailureCooldownMs,
      failureThreshold: spec.failureThreshold ?? BASE_DEFAULTS.failureThreshold,
      maxConcurrentRequests: spec.maxConcurrentRequests ?? BASE_DEFAULTS.maxConcurrentRequests,
    });
    if (!result.ok) throw new Error(`seed failed for ${id}: ${result.error}`);
    seeded[id] = { enabled: spec.enabled ?? true, baseUrl, modelId };
  }
  return seeded;
}

export function routerStub(): DurableObjectStub<AiRouterCoordinator> {
  // cloudflare:test's `env` is typed as the generated Cloudflare.Env; tests only need
  // the DO namespace binding declared in wrangler.jsonc.
  const namespace = (env as unknown as { AI_ROUTER: DurableObjectNamespace }).AI_ROUTER;
  const id = namespace.idFromName("gpt-oss-120b");
  return namespace.get(id) as DurableObjectStub<AiRouterCoordinator>;
}

export async function statusMap(
  stub = routerStub(),
): Promise<Map<string, ProviderStatusView>> {
  const { providers } = await stub.listProviders();
  return new Map(providers.map((p) => [p.id, p]));
}

export async function acquire(
  stub: DurableObjectStub<AiRouterCoordinator>,
  requestId = crypto.randomUUID(),
  excludeProviderIds?: string[],
): Promise<AcquireProviderResult> {
  return stub.acquireProvider({ model: "gpt-oss-120b", requestId, excludeProviderIds });
}

export const CHAT_URL = "http://router.internal/v1/chat/completions";

export function chatRequest(body: unknown, key: string = ROUTER_KEY): Request {
  return new Request(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

export const CHAT_BODY = {
  model: "gpt-oss-120b",
  messages: [{ role: "user", content: "hi" }],
};

export const COMPLETION_BODY = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "fake-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

export function sseBody(events: string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";
}

export function activateFetchMock(): void {
  fetchMock.activate();
  fetchMock.disableNetConnect();
}

export function deactivateFetchMock(): void {
  fetchMock.deactivate();
}

export interface MockUpstreamOptions {
  status?: number;
  body?: unknown;
  contentType?: string;
  delayMs?: number;
  onRequest?: (requestBody: string) => void;
}

/**
 * Register a POST {baseUrl}/chat/completions interceptor. `onRequest` captures the raw
 * upstream body (for model-rewrite assertions). Call counts land in `times[0]`.
 */
export function mockUpstream(
  baseUrl: string,
  opts: MockUpstreamOptions,
  times: number[] = [],
): void {
  const origin = new URL(baseUrl).origin;
  const path = `${new URL(baseUrl).pathname}/chat/completions`;
  const data =
    opts.body === undefined
      ? ""
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  const replyFn = opts.onRequest
    ? (async (call: { body?: unknown }): Promise<string> => {
        times[0] = (times[0] ?? 0) + 1;
        opts.onRequest!(typeof call.body === "string" ? call.body : "");
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        return data;
      })
    : (async (): Promise<string> => {
        times[0] = (times[0] ?? 0) + 1;
        if (opts.delayMs !== undefined) await sleep(opts.delayMs);
        return data;
      });
  fetchMock
    .get(origin)
    .intercept({ method: "POST", path })
    .reply(opts.status ?? 200, replyFn, {
      headers: { "Content-Type": opts.contentType ?? "application/json" },
    })
    .persist(); // interceptors are single-use in undici unless persisted
}

/** Simple percentile from a sorted-or-unsorted latency array (ms). */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
