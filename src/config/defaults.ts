/**
 * Static defaults. These SEED the DO providers table on first access; afterwards the
 * admin API is the source of truth. Base URLs / model ids are initial defaults that must
 * be verified against current provider docs before production — never guessed secrets.
 */
import type { ProviderConfig } from "../types/provider";

export const LOGICAL_MODEL = "gpt-oss-120b";

export const DEFAULT_LEASE_TTL_MS = 600_000; // 10 min: must exceed longest generation

/**
 * Bump to re-assert these defaults onto the live DO's providers table: config rows are
 * upserted and the re-asserted providers' breaker state resets to healthy. Admin-created
 * providers and admin config edits to OTHER fields after the bump are untouched.
 */
export const DEFAULT_SEED_VERSION = 4;

type Seed = Omit<
  ProviderConfig,
  "baseUrl" | "createdAt" | "updatedAt" | "pendingDeletion"
> & { baseUrl: string | null };

export const DEFAULT_PROVIDER_SEED: Seed[] = [
  {
    id: "deepinfra",
    enabled: true,
    baseUrl: "https://api.deepinfra.com/v1/openai",
    baseUrlEnv: null,
    modelId: "openai/gpt-oss-120b",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    timeoutMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 50,
  },
  {
    id: "akashml",
    enabled: true,
    baseUrl: "https://api.akash.network/v1",
    baseUrlEnv: null,
    modelId: "openai/gpt-oss-120b",
    apiKeyEnv: "AKASHML_API_KEY",
    timeoutMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 50,
  },
  {
    id: "modal",
    enabled: true,
    // Existing Modal GPT-OSS-120B endpoint — consumed, never redeployed from here.
    // URL arrives via env var so no environment-specific value lands in source.
    baseUrl: null,
    baseUrlEnv: "MODAL_BASE_URL",
    modelId: "openai/gpt-oss-120b",
    apiKeyEnv: "MODAL_API_KEY", // optional upstream; set null via admin API if the endpoint needs no auth
    // Cold starts: give Modal a larger time-to-first-response budget.
    timeoutMs: 180_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 5,
  },
];

export const DEFAULT_MAX_PROVIDER_ATTEMPTS = 3;
