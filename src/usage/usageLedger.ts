/**
 * Usage ledger: one D1 row per provider attempt (tokens in/out, duration, status).
 * All writes go through ctx.waitUntil — a slow or failing insert can never affect the
 * client response. Prompts/completions are NEVER stored, only numeric usage metadata.
 */
import type { Env } from "../config/env";
import { log } from "../utils/logging";

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
}

export const EMPTY_USAGE: TokenUsage = {
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
  finishReason: null,
};

export interface ProviderCallRecord extends TokenUsage {
  requestId: string;
  provider: string;
  logicalModel: string;
  upstreamModel: string | null;
  stream: boolean;
  status: number | null;
  failureClass: string | null;
  latencyMs: number;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Extract usage from a non-streaming completion JSON body. */
export function extractUsageFromCompletion(body: unknown): TokenUsage {
  if (typeof body !== "object" || body === null) return EMPTY_USAGE;
  const obj = body as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? (obj.choices as unknown[]) : [];
  const first = typeof choices[0] === "object" && choices[0] !== null ? (choices[0] as Record<string, unknown>) : undefined;
  const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : null;
  const usage = typeof obj.usage === "object" && obj.usage !== null ? (obj.usage as Record<string, unknown>) : undefined;
  if (!usage) return { ...EMPTY_USAGE, finishReason };
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    finishReason,
  };
}

/**
 * Extract the LAST usage object seen in a dumped SSE stream (providers emit usage in a
 * final chunk when stream_options.include_usage is set). Bounded to the trailing 512KB
 * of the dump — the usage chunk is always at the end.
 */
export function extractUsageFromSseDump(dump: string): TokenUsage {
  const tail = dump.length > 524_288 ? dump.slice(-524_288) : dump;
  let found: TokenUsage = EMPTY_USAGE;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
      const parsed = extractUsageFromCompletion(chunk);
      if (
        parsed.promptTokens !== null ||
        parsed.completionTokens !== null ||
        parsed.finishReason !== null
      ) {
        // Usage arrives in its own final chunk; keep the most complete view seen.
        found = {
          finishReason: parsed.finishReason ?? found.finishReason,
          promptTokens: parsed.promptTokens ?? found.promptTokens,
          completionTokens: parsed.completionTokens ?? found.completionTokens,
          totalTokens: parsed.totalTokens ?? found.totalTokens,
        };
      }
    } catch {
      // non-JSON line (e.g. comment) — ignore
    }
  }
  return found;
}

function insertRow(env: Env, rec: ProviderCallRecord): Promise<unknown> {
  return env.USAGE_DB!.prepare(
    `INSERT INTO provider_calls (
      ts, request_id, provider, logical_model, upstream_model, stream,
      status, failure_class, finish_reason, prompt_tokens, completion_tokens,
      total_tokens, latency_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      Date.now(),
      rec.requestId,
      rec.provider,
      rec.logicalModel,
      rec.upstreamModel,
      rec.stream ? 1 : 0,
      rec.status,
      rec.failureClass,
      rec.finishReason,
      rec.promptTokens,
      rec.completionTokens,
      rec.totalTokens,
      rec.latencyMs,
    )
    .run();
}

/** Fire-and-forget ledger write. No-op when the binding is absent; never throws. */
export function recordProviderCall(env: Env, ctx: ExecutionContext, rec: ProviderCallRecord): void {
  if (!env.USAGE_DB) {
    log.debug("usage_ledger_disabled", { requestId: rec.requestId, provider: rec.provider });
    return;
  }
  ctx.waitUntil(
    insertRow(env, rec)
      .then(() => log.debug("usage_recorded", { requestId: rec.requestId, provider: rec.provider }))
      .catch((err: unknown) =>
        log.warn("usage_record_failed", {
          requestId: rec.requestId,
          provider: rec.provider,
          message: err instanceof Error ? err.message : "unknown",
        }),
      ),
  );
}
