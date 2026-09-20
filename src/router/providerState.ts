/**
 * Eligibility rules for health-aware round robin, derived half-open state, and the
 * safe status view. Pure functions — the DO persists the inputs they read.
 */
import type { ProviderConfig, ProviderRuntimeState, ProviderStatusView } from "../types/provider";

export function initialState(providerId: string): ProviderRuntimeState {
  return {
    providerId,
    status: "healthy",
    consecutiveFailures: 0,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureStatus: null,
  };
}

/**
 * Stored 'cooldown' whose window has elapsed presents as 'half_open' (one probe allowed).
 */
export function effectiveStatus(
  state: ProviderRuntimeState,
  now: number,
): ProviderStatusView["status"] {
  if (state.status === "disabled") return "disabled";
  if (state.status === "cooldown") {
    return state.cooldownUntil !== null && now < state.cooldownUntil ? "cooldown" : "half_open";
  }
  return "healthy";
}

export interface Eligibility {
  cfg: ProviderConfig;
  state: ProviderRuntimeState;
  activeRequests: number;
  now: number;
  excluded: ReadonlySet<string>;
}

/** enabled AND not excluded AND under capacity AND not blocked by breaker state. */
export function isEligible(input: Eligibility): boolean {
  const { cfg, state, activeRequests, now, excluded } = input;
  if (!cfg.enabled || cfg.pendingDeletion) return false;
  if (excluded.has(cfg.id)) return false;
  if (activeRequests >= cfg.maxConcurrentRequests) return false;
  const status = effectiveStatus(state, now);
  if (status === "disabled") return false;
  if (status === "cooldown") return false;
  if (status === "half_open") return !state.halfOpenProbeActive; // single-probe rule
  return true;
}

export function toStatusView(
  cfg: ProviderConfig,
  state: ProviderRuntimeState,
  activeRequests: number,
  now: number,
): ProviderStatusView {
  return {
    id: cfg.id,
    enabled: cfg.enabled,
    status: effectiveStatus(state, now),
    pendingDeletion: cfg.pendingDeletion,
    activeRequests,
    maxConcurrentRequests: cfg.maxConcurrentRequests,
    consecutiveFailures: state.consecutiveFailures,
    cooldownUntil: state.cooldownUntil,
    halfOpenProbeActive: state.halfOpenProbeActive,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastFailureStatus: state.lastFailureStatus,
  };
}
