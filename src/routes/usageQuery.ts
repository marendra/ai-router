/**
 * GET /v1/usage?from=...&to=...&provider=...
 * Query the D1 usage ledger with a date range. Authenticated with the same router key
 * Gruuvix uses for inference. Aggregates only — never prompt/completion content.
 *
 * Params:
 *   from     ISO date (YYYY-MM-DD) or datetime. Default: 7 days ago.
 *   to       ISO date (YYYY-MM-DD) or datetime. Inclusive for date-only values.
 *            Default: now. Range capped at 92 days.
 *   provider optional filter (e.g. deepinfra).
 */
import type { Env } from "../config/env";
import { errorResponse, invalidRequest } from "../utils/errors";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = 92;

export type RangeResult = { from: number; to: number } | "invalid";

/** Resolve from/to epoch-ms bounds. Date-only bounds align to the requested timezone
 * (tz = UTC offset in hours, e.g. 7 = WIB), so "a day" means that zone's day. */
export function parseUsageRange(url: URL, now: number): RangeResult {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const tzRaw = url.searchParams.get("tz");

  const tzParsed = tzRaw !== null ? Number.parseInt(tzRaw, 10) : 0;
  const tz = Number.isFinite(tzParsed) && tzParsed >= -12 && tzParsed <= 14 ? tzParsed : 0;
  const tzShiftMs = tz * 3_600_000;

  let from = now - DEFAULT_RANGE_DAYS * DAY_MS;
  if (fromRaw !== null && fromRaw !== "") {
    from = DATE_ONLY.test(fromRaw)
      ? Date.parse(`${fromRaw}T00:00:00.000Z`) - tzShiftMs
      : Date.parse(fromRaw);
    if (!Number.isFinite(from)) return "invalid";
  }

  let to = now;
  if (toRaw !== null && toRaw !== "") {
    to = DATE_ONLY.test(toRaw) ? Date.parse(`${toRaw}T00:00:00.000Z`) : Date.parse(toRaw);
    if (!Number.isFinite(to)) return "invalid";
    if (DATE_ONLY.test(toRaw)) to += DAY_MS - tzShiftMs; // inclusive day in that zone
  }

  if (from > to) return "invalid";
  if (to - from > MAX_RANGE_DAYS * DAY_MS) return "invalid";
  return { from, to };
}

/** Quoted SQLite modifier shifting the UTC day bucket into the requested zone
 * (tz integer-validated, so interpolation is injection-safe). */
function dayBucketModifier(url: URL): string {
  const tzParsed = Number.parseInt(url.searchParams.get("tz") ?? "", 10);
  const tz = Number.isFinite(tzParsed) && tzParsed >= -12 && tzParsed <= 14 ? tzParsed : 0;
  return `'${tz >= 0 ? "+" : "-"}${Math.abs(tz)} hours'`;
}

interface ProviderAggregate {
  provider: string;
  calls: number;
  ok_calls: number;
  failures: number;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  avg_ms: number;
  max_ms: number;
}

interface DailyRow {
  day: string;
  provider: string;
  calls: number;
  failures: number;
  tokens_in: number;
  tokens_out: number;
}

interface FailureClassRow {
  provider: string;
  failure_class: string;
  status: number | null;
  count: number;
}

interface RecentFailureRow {
  ts: number;
  provider: string;
  failure_class: string | null;
  status: number | null;
  latency_ms: number;
}

const FAILED_ATTEMPT = "(status IS NULL OR status < 200 OR status >= 300)";

export async function handleUsageQuery(env: Env, url: URL, requestId: string): Promise<Response> {
  // Validate inputs first so clients get 400s (not a ledger-unavailable 503) for bad params.
  const range = parseUsageRange(url, Date.now());
  if (range === "invalid") {
    return invalidRequest(
      "Invalid date range. Use from/to as YYYY-MM-DD or ISO datetime (range capped at 92 days, from must precede to).",
      "invalid_usage_range",
    );
  }
  const { from, to } = range;

  const providerParam = url.searchParams.get("provider");
  if (providerParam !== null && !PROVIDER_ID.test(providerParam)) {
    return invalidRequest("Invalid provider filter.", "invalid_provider");
  }

  if (!env.USAGE_DB) {
    return errorResponse(
      503,
      "Usage ledger is not available in this environment.",
      "service_unavailable",
      "usage_unavailable",
    );
  }

  const providerClause = providerParam !== null ? " AND provider = ?" : "";
  const providerBind = providerParam !== null ? [providerParam] : [];

  const perProvider = await env.USAGE_DB.prepare(
    `SELECT provider,
            COUNT(*) AS calls,
            SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok_calls,
            SUM(CASE WHEN ${FAILED_ATTEMPT} THEN 1 ELSE 0 END) AS failures,
            SUM(COALESCE(prompt_tokens, 0)) AS tokens_in,
            SUM(COALESCE(completion_tokens, 0)) AS tokens_out,
            SUM(COALESCE(total_tokens, 0)) AS tokens_total,
            CAST(AVG(latency_ms) AS INTEGER) AS avg_ms,
            MAX(latency_ms) AS max_ms
     FROM provider_calls
     WHERE ts >= ? AND ts < ?${providerClause}
     GROUP BY provider
     ORDER BY calls DESC`,
  )
    .bind(from, to, ...providerBind)
    .all<ProviderAggregate>();

  const daily = await env.USAGE_DB.prepare(
    `SELECT date(ts / 1000, 'unixepoch', ${dayBucketModifier(url)}) AS day,
            provider,
            COUNT(*) AS calls,
            SUM(CASE WHEN ${FAILED_ATTEMPT} THEN 1 ELSE 0 END) AS failures,
            SUM(COALESCE(prompt_tokens, 0)) AS tokens_in,
            SUM(COALESCE(completion_tokens, 0)) AS tokens_out
     FROM provider_calls
     WHERE ts >= ? AND ts < ?${providerClause}
     GROUP BY day, provider
     ORDER BY day DESC, provider`,
  )
    .bind(from, to, ...providerBind)
    .all<DailyRow>();

  const failureClasses = await env.USAGE_DB.prepare(
    `SELECT provider,
            COALESCE(NULLIF(failure_class, ''), 'unknown') AS failure_class,
            status,
            COUNT(*) AS count
     FROM provider_calls
     WHERE ts >= ? AND ts < ?${providerClause} AND ${FAILED_ATTEMPT}
     GROUP BY provider, failure_class, status
     ORDER BY count DESC`,
  )
    .bind(from, to, ...providerBind)
    .all<FailureClassRow>();

  const recentFailures = await env.USAGE_DB.prepare(
    `SELECT ts, provider, failure_class, status, latency_ms
     FROM provider_calls
     WHERE ts >= ? AND ts < ?${providerClause} AND ${FAILED_ATTEMPT}
     ORDER BY ts DESC
     LIMIT 20`,
  )
    .bind(from, to, ...providerBind)
    .all<RecentFailureRow>();

  const providers = perProvider.results ?? [];
  const total = providers.reduce(
    (acc, p) => ({
      calls: acc.calls + Number(p.calls),
      tokens_in: acc.tokens_in + Number(p.tokens_in),
      tokens_out: acc.tokens_out + Number(p.tokens_out),
    }),
    { calls: 0, tokens_in: 0, tokens_out: 0 },
  );

  return new Response(
    JSON.stringify({
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      tz: url.searchParams.get("tz") ?? "0",
      provider: providerParam,
      total,
      providers,
      daily: daily.results ?? [],
      failureClasses: failureClasses.results ?? [],
      recentFailures: recentFailures.results ?? [],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
    },
  );
}
