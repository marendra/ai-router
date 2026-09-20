/**
 * POST /v1/chat/completions — the routing attempt loop.
 *
 * Failover policy: retry on transient/provider classes with exclusion (never the same
 * provider twice per request); 400/422 pass through to the client untouched; once a
 * 2xx stream has started, never replay with another provider.
 */
import { LOGICAL_MODEL, DEFAULT_LEASE_TTL_MS, DEFAULT_MAX_PROVIDER_ATTEMPTS } from "../config/defaults";
import { getEnvVar, resolveSecret, type Env } from "../config/env";
import { callProvider } from "../providers/openAiCompatibleProvider";
import { classifyFetchError, classifyUpstreamStatus, shouldFailover } from "../router/failureClassifier";
import type { AiRouterCoordinator } from "../durableObjects/AiRouterCoordinator";
import type { FailureClass, ProviderConfigSnapshot } from "../types/router";
import type { ChatCompletionRequestBody } from "../types/openai";
import { log } from "../utils/logging";
import {
  allProvidersFailed,
  errorResponse,
  invalidRequest,
  modelNotSupported,
  noProviderAvailable,
} from "../utils/errors";
import { buildStreamResponseHeaders, pipeUpstreamStream } from "./streaming";
import {
  EMPTY_USAGE,
  extractUsageFromCompletion,
  recordProviderCall,
  type TokenUsage,
} from "../usage/usageLedger";

function withExtraHeaders(base: Headers, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

function debugHeadersEnabled(env: Env): boolean {
  const flag = getEnvVar(env, "ROUTER_DEBUG_HEADERS");
  return flag === "true" || flag === "1";
}

function debugHeaderMap(
  env: Env,
  fields: { providerId?: string; attempts?: number; requestId: string },
): Record<string, string> {
  const headers: Record<string, string> = { "x-request-id": fields.requestId };
  if (debugHeadersEnabled(env)) {
    if (fields.providerId) headers["x-gruuvix-provider"] = fields.providerId;
    if (fields.attempts !== undefined) headers["x-gruuvix-attempts"] = String(fields.attempts);
  }
  return headers;
}

function responseWithHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const value = (await req.json()) as unknown;
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function handleChatCompletions(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalidRequest("Request body must be valid JSON.");

  const body = parsed.value;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalidRequest("Request body must be a JSON object.");
  }
  const chat = body as ChatCompletionRequestBody;
  if (typeof chat.model !== "string" || chat.model.length === 0) {
    return invalidRequest("'model' is required.");
  }
  if (chat.model !== LOGICAL_MODEL) return modelNotSupported(chat.model);
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    return invalidRequest("'messages' must be a non-empty array.");
  }
  const streaming = chat.stream === true;

  const stub = env.AI_ROUTER.getByName(chat.model) as unknown as AiRouterCoordinator;
  const maxAttempts = parsePositiveInt(
    getEnvVar(env, "MAX_PROVIDER_ATTEMPTS"),
    DEFAULT_MAX_PROVIDER_ATTEMPTS,
    10,
  );
  const leaseTtlMs = parsePositiveInt(
    getEnvVar(env, "LEASE_TTL_MS"),
    DEFAULT_LEASE_TTL_MS,
    3_600_000,
  );

  const attempted: string[] = [];
  let lastFailureClass: FailureClass | null = null;
  let lastFailureStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A client that already disconnected must not trigger (and pay for) inference.
    if (req.signal.aborted) {
      return errorResponse(499, "Client disconnected.", "client_error", "client_abort");
    }

    const acquisition = await stub.acquireProvider({
      model: chat.model,
      requestId,
      excludeProviderIds: attempted,
      leaseTtlMs,
    });

    if (!acquisition.ok) {
      log.info("no_provider_available", { requestId, attempted: attempted.join(",") });
      // Nothing eligible at all → 503; after real attempts → 502 per error contract.
      if (attempted.length === 0) return withRequestId(noProviderAvailable(), requestId);
      break;
    }

    const { providerId, leaseId, config: cfg } = acquisition;

    // Resolve config against env bindings. Missing configuration is a provider fault.
    const baseUrl =
      cfg.baseUrl ?? (cfg.baseUrlEnv ? await resolveSecret(env, cfg.baseUrlEnv) : undefined);
    if (!baseUrl) {
      log.warn("provider_config_missing", { requestId, providerId, field: "baseUrl" });
      await stub.reportFailure({
        leaseId,
        providerId,
        status: null,
        failureClass: "model_configuration_error",
      });
      attempted.push(providerId);
      lastFailureClass = "model_configuration_error";
      continue;
    }
    const apiKey = cfg.apiKeyEnv ? await resolveSecret(env, cfg.apiKeyEnv) : undefined;
    if (cfg.apiKeyEnv && !apiKey) {
      log.warn("provider_config_missing", { requestId, providerId, field: cfg.apiKeyEnv });
      await stub.reportFailure({
        leaseId,
        providerId,
        status: null,
        failureClass: "authentication_error",
      });
      attempted.push(providerId);
      lastFailureClass = "authentication_error";
      continue;
    }

    // Model rewrite: only the model field changes; everything else passes through.
    const upstreamBody: Record<string, unknown> = { ...chat, model: cfg.modelId };
    // Default reasoning effort (Gruuvix workload = sentence summarization → "low").
    // An explicit client-supplied reasoning_effort always wins.
    if (upstreamBody.reasoning_effort === undefined) {
      upstreamBody.reasoning_effort = getEnvVar(env, "DEFAULT_REASONING_EFFORT") ?? "low";
    }
    // Ask streaming providers for a usage-bearing final chunk (harvested by the ledger).
    if (streaming && upstreamBody.stream_options === undefined) {
      upstreamBody.stream_options = { include_usage: true };
    }
    const startedAt = Date.now();

    // One controller per attempt: the upstream timeout AND client cancellation both
    // abort the fetch. For STREAMING the timeout means time-to-first-response only —
    // the timer is cleared once headers arrive and the idle watchdog governs the body,
    // so a healthy long stream is never cut. For non-streaming it is the total timeout
    // and stays armed through the body read.
    const abort = new AbortController();
    const onClientAbort = (): void =>
      abort.abort(new DOMException("client aborted", "AbortError"));
    req.signal.addEventListener("abort", onClientAbort, { once: true });
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      abort.abort(new DOMException("upstream timeout", "TimeoutError"));
    }, cfg.timeoutMs);

    let upstream: Response;
    try {
      upstream = await callProvider({
        config: cfg,
        resolvedBaseUrl: baseUrl,
        apiKey,
        body: upstreamBody,
        signal: abort.signal,
      });
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      req.signal.removeEventListener("abort", onClientAbort);
      const failureClass = classifyFetchError(err, req.signal.aborted);
      const latencyMs = Date.now() - startedAt;
      await stub.reportFailure({ leaseId, providerId, status: null, failureClass, latencyMs });
      recordProviderCall(env, ctx, {
        requestId, provider: providerId, logicalModel: chat.model, upstreamModel: cfg.modelId,
        stream: streaming, status: null, failureClass, latencyMs, ...EMPTY_USAGE,
      });
      log.info("upstream_attempt_failed", {
        requestId, providerId, attempt, failureClass, latencyMs, result: "fetch_error",
      });
      if (failureClass === "client_abort") {
        return errorResponse(499, "Client disconnected.", "client_error", "client_abort");
      }
      attempted.push(providerId);
      lastFailureClass = failureClass;
      if (!shouldFailover(failureClass)) break;
      continue;
    }
    // Headers arrived. For streaming this closes the failover/timeout window: the
    // response is now governed by the stream idle watchdog, not by timeoutMs.
    if (streaming && timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    if (!upstream.ok) {
      const failureClass = classifyUpstreamStatus(upstream.status);
      const latencyMs = Date.now() - startedAt;
      recordProviderCall(env, ctx, {
        requestId, provider: providerId, logicalModel: chat.model, upstreamModel: cfg.modelId,
        stream: streaming, status: upstream.status, failureClass, latencyMs, ...EMPTY_USAGE,
      });
      log.info("upstream_attempt_failed", {
        requestId, providerId, attempt, failureClass, upstreamStatus: upstream.status, latencyMs,
      });
      if (!shouldFailover(failureClass)) {
        // Request's fault (400/422): release lease WITHOUT penalty, pass error through.
        await stub.reportFailure({ leaseId, providerId, status: upstream.status, failureClass, latencyMs });
        return responseWithHeaders(upstream, { "x-request-id": requestId });
      }
      await stub.reportFailure({ leaseId, providerId, status: upstream.status, failureClass, latencyMs });
      attempted.push(providerId);
      lastFailureClass = failureClass;
      lastFailureStatus = upstream.status;
      continue;
    }

    // Upstream 2xx: the failover window closes here.
    if (!streaming) {
      // Total-timeout window (timer still armed) covers the body read. A body-read
      // failure is a provider failure: report it and fail over — nothing has been
      // sent to the client yet, so retrying is safe.
      let bodyText: string;
      try {
        bodyText = await upstream.text();
      } catch (err) {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        req.signal.removeEventListener("abort", onClientAbort);
        const failureClass = classifyFetchError(err, req.signal.aborted);
        const latencyMs = Date.now() - startedAt;
        await stub.reportFailure({ leaseId, providerId, status: null, failureClass, latencyMs });
        recordProviderCall(env, ctx, {
          requestId, provider: providerId, logicalModel: chat.model, upstreamModel: cfg.modelId,
          stream: false, status: null, failureClass, latencyMs, ...EMPTY_USAGE,
        });
        log.info("upstream_attempt_failed", {
          requestId, providerId, attempt, failureClass, latencyMs, result: "body_read_error",
        });
        if (failureClass === "client_abort") {
          return errorResponse(499, "Client disconnected.", "client_error", "client_abort");
        }
        attempted.push(providerId);
        lastFailureClass = failureClass;
        if (!shouldFailover(failureClass)) break;
        continue;
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      req.signal.removeEventListener("abort", onClientAbort);
      const latencyMs = Date.now() - startedAt;
      // Usage extraction must never break passthrough of an otherwise-valid body.
      let usage: TokenUsage = EMPTY_USAGE;
      try {
        usage = extractUsageFromCompletion(JSON.parse(bodyText));
      } catch {
        usage = EMPTY_USAGE;
      }
      await stub.reportSuccess({ leaseId, providerId, latencyMs });
      recordProviderCall(env, ctx, {
        requestId, provider: providerId, logicalModel: chat.model, upstreamModel: cfg.modelId,
        stream: false, status: upstream.status, failureClass: null, latencyMs,
        promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens, finishReason: usage.finishReason,
      });
      log.info("request_completed", {
        requestId, finalProvider: providerId, stream: false,
        attemptCount: attempt, attemptedProviders: attempted.join(","), latencyMs, success: true,
      });
      const debug = debugHeaderMap(env, { providerId, attempts: attempt, requestId });
      return new Response(bodyText, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: withExtraHeaders(upstream.headers, debug),
      });
    }

    const streamHeaders = buildStreamResponseHeaders(
      upstream,
      requestId,
      debugHeaderMap(env, { providerId, attempts: attempt, requestId }),
    );
    // Single stream, no tee(): the pump forwards bytes to the client AND harvests the
    // usage chunk. Cancelling the client side therefore cancels the upstream fetch —
    // no orphaned generation after the lease is released.
    const readable = pipeUpstreamStream({
      req,
      upstream,
      body: upstream.body!,
      stub,
      providerId,
      leaseId,
      config: cfg,
      requestId,
      startedAt,
      // NOTE: must wrap — destructured ctx.waitUntil loses its `this` in production.
      waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
      collectUsage: env.USAGE_DB !== undefined,
      onSettled: (outcome) => {
        // Ledger row reflects the FINAL outcome: failures carry their class and the
        // duration includes the whole stream, not just time-to-headers.
        recordProviderCall(env, ctx, {
          requestId, provider: providerId, logicalModel: chat.model, upstreamModel: cfg.modelId,
          stream: true, status: upstream.status,
          failureClass: outcome.success ? null : outcome.failureClass,
          latencyMs: outcome.latencyMs,
          promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens,
          totalTokens: outcome.totalTokens, finishReason: outcome.finishReason,
        });
      },
    });
    // The pump installs its own abort listener on req.signal from here.
    req.signal.removeEventListener("abort", onClientAbort);
    log.info("stream_started", { requestId, providerId, attempt });
    return new Response(readable, { status: upstream.status, headers: streamHeaders });
  }

  const detail =
    `last failure: ${lastFailureClass ?? "unknown"}` +
    (lastFailureStatus !== null ? ` (HTTP ${lastFailureStatus})` : "");
  log.warn("request_failed", {
    requestId, stream: streaming, attemptCount: attempted.length,
    attemptedProviders: attempted.join(","), success: false, failureClass: lastFailureClass,
  });
  return withRequestId(allProvidersFailed(detail), requestId);
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, headers });
}
