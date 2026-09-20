import type { ProviderConfig } from "./provider";

export const FAILURE_CLASSES = [
  "client_error",
  "rate_limit",
  "provider_overloaded",
  "provider_error",
  "timeout",
  "network_error",
  "authentication_error",
  "credit_error",
  "model_configuration_error",
  "stream_interrupted",
  "client_abort",
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface AcquireProviderRequest {
  model: string;
  requestId: string;
  excludeProviderIds?: string[];
  /** Override for the lease TTL (crash-safety window). Defaults to DEFAULT_LEASE_TTL_MS. */
  leaseTtlMs?: number;
}

/** Non-secret config snapshot handed to the Worker together with the lease. */
export type ProviderConfigSnapshot = Pick<
  ProviderConfig,
  | "id"
  | "baseUrl"
  | "baseUrlEnv"
  | "modelId"
  | "apiKeyEnv"
  | "timeoutMs"
  | "streamIdleTimeoutMs"
>;

export type AcquireProviderResult =
  | {
      ok: true;
      providerId: string;
      leaseId: string;
      expiresAt: number;
      config: ProviderConfigSnapshot;
    }
  | { ok: false; reason: "no_provider_available" };

export interface ReportSuccessRequest {
  leaseId: string;
  providerId: string;
  latencyMs?: number;
}

export interface ReportFailureRequest {
  leaseId: string;
  providerId: string;
  status: number | null;
  failureClass: FailureClass;
  latencyMs?: number;
}
