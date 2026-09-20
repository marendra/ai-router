import type { FailureClass } from "../types/router";

/**
 * Centralized failure classification. Route handlers never branch on raw status codes —
 * everything goes through here.
 */

/** Map an upstream HTTP status to a failure class. */
export function classifyUpstreamStatus(status: number): FailureClass {
  if (status === 400 || status === 422) return "client_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 402) return "credit_error";
  // 404 upstream = wrong endpoint path or unknown model: provider configuration is broken.
  if (status === 404) return "model_configuration_error";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 500 || status === 529) return "provider_overloaded";
  if (status === 502 || status === 504) return "provider_error";
  if (status === 503) return "provider_overloaded";
  if (status >= 500) return "provider_error";
  return "unknown";
}

/** Distinguish fetch exceptions: timeout (our AbortSignal), client abort, network error. */
export function classifyFetchError(err: unknown, clientAborted: boolean): FailureClass {
  if (clientAborted) return "client_abort";
  if (err instanceof DOMException || err instanceof Error) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      // If the CLIENT aborted, its signal fires AbortError too — handled above.
      return "timeout";
    }
  }
  return "network_error";
}

const FAILOVER_CLASSES: ReadonlySet<FailureClass> = new Set([
  "network_error",
  "timeout",
  "rate_limit",
  "provider_overloaded",
  "provider_error",
  "credit_error",
  "authentication_error",
  "model_configuration_error",
  "unknown",
]);

/** Should we try another provider? (Only ever before any byte reached the client.) */
export function shouldFailover(failureClass: FailureClass): boolean {
  return FAILOVER_CLASSES.has(failureClass);
}

/** Should this failure count toward circuit-breaker state? Client faults don't. */
export function isPenalizing(failureClass: FailureClass): boolean {
  return failureClass !== "client_error" && failureClass !== "client_abort";
}

/** Cooldown multiplier/class for long provider-configuration failures. */
export function cooldownClass(
  failureClass: FailureClass,
): "normal" | "auth" | "credit" {
  if (failureClass === "authentication_error" || failureClass === "model_configuration_error") {
    return "auth";
  }
  if (failureClass === "credit_error") return "credit";
  return "normal";
}
