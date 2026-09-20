/**
 * Non-secret provider configuration. Lives in the DO `providers` table (admin-editable)
 * and is seeded from config/defaults.ts. Secrets are referenced BY NAME only.
 */
export interface ProviderConfig {
  id: string;
  enabled: boolean;
  /** API root such that `${baseUrl}/chat/completions` is the endpoint. Null when baseUrlEnv is used. */
  baseUrl: string | null;
  /** Alternative to literal baseUrl: env var NAME holding the URL (e.g. MODAL_BASE_URL). */
  baseUrlEnv: string | null;
  /** Provider-specific upstream model identifier (e.g. "openai/gpt-oss-120b"). */
  modelId: string;
  /** Env var NAME of the Cloudflare secret; null = upstream needs no Authorization (Modal). */
  apiKeyEnv: string | null;
  /** Time-to-first-response (connect + response headers) timeout in ms. */
  timeoutMs: number;
  /** Max inactivity (no bytes) once a stream has started, in ms. */
  streamIdleTimeoutMs: number;
  cooldownMs: number;
  authFailureCooldownMs: number;
  creditFailureCooldownMs: number;
  failureThreshold: number;
  maxConcurrentRequests: number;
  /** Deleted while leases still active: no new leases, rows removed once drained. */
  pendingDeletion: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Runtime health state, kept separate from configuration. */
export interface ProviderRuntimeState {
  providerId: string;
  /** Stored status. "half_open" is DERIVED (cooldown elapsed, probe not yet resolved). */
  status: "healthy" | "cooldown" | "disabled";
  consecutiveFailures: number;
  cooldownUntil: number | null;
  /** Exactly one in-flight probe allowed while half-open. */
  halfOpenProbeActive: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureStatus: number | null;
}

/** A short-lived capacity reservation. Active concurrency = COUNT(unexpired leases). */
export interface Lease {
  leaseId: string;
  providerId: string;
  requestId: string;
  createdAt: number;
  expiresAt: number;
}

/** Safe status view for admin/readiness APIs — never contains secrets. */
export interface ProviderStatusView {
  id: string;
  enabled: boolean;
  status: "healthy" | "cooldown" | "half_open" | "disabled";
  pendingDeletion: boolean;
  activeRequests: number;
  maxConcurrentRequests: number;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  halfOpenProbeActive: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureStatus: number | null;
}
