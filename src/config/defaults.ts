/**
 * Static defaults. These SEED the DO providers table on first access; afterwards the
 * admin API is the source of truth. Base URLs / model ids are initial defaults that must
 * be verified against current provider docs before production — never guessed secrets.
 */
import type { ProviderConfig } from "../types/provider";

export const LOGICAL_MODEL = "gpt-oss-120b";

export const DEFAULT_LEASE_TTL_MS = 600_000; // 10 min: must exceed longest generation

/**
 * Bumps normally re-assert default config and reset the affected breaker state.
 * The v13-v15 upgrades preserve other providers: v14 adds OpenRouter and v15
 * retires both Crusoe slots using the normal drain-before-delete behavior.
 */
export const DEFAULT_SEED_VERSION = 15; // v15: remove crusoe and crusoe2

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
    baseUrl: "https://api.akashml.com/v1", // api.akash.network is dead (NXDOMAIN) — AkashML migrated domains
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
    id: "akashml2",
    enabled: true,
    // Second AkashML account (separate credit card / rate-limit bucket).
    baseUrl: "https://api.akashml.com/v1", // api.akash.network is dead (NXDOMAIN) — AkashML migrated domains
    baseUrlEnv: null,
    modelId: "openai/gpt-oss-120b",
    apiKeyEnv: "AKASH_SECOND_KEY",
    timeoutMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 50,
  },
  {
    id: "novita",
    enabled: true,
    // Novita AI OpenAI-compatible inference. `${baseUrl}/chat/completions` is the endpoint
    // (their documented OpenAI root is /v3/openai).
    baseUrl: "https://api.novita.ai/v3/openai",
    baseUrlEnv: null,
    modelId: "openai/gpt-oss-120b", // Novita's slug (404s on the unprefixed id)
    apiKeyEnv: "NOVITA_API_KEY",
    timeoutMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 50,
  },
  {
    id: "openrouter",
    enabled: true,
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: null,
    // :floor prioritizes the cheapest provider for this exact model, not a different
    // model. Keep the client-facing gpt-oss-120b contract intact.
    modelId: "openai/gpt-oss-120b:floor",
    apiKeyEnv: "OPENROUTER_API_KEY",
    timeoutMs: 60_000,
    streamIdleTimeoutMs: 60_000,
    cooldownMs: 30_000,
    authFailureCooldownMs: 15 * 60_000,
    creditFailureCooldownMs: 30 * 60_000,
    failureThreshold: 2,
    maxConcurrentRequests: 5,
  },
  {
    id: "modal",
    // DROPPED from rotation (owner decision, 2026-09-20): app is down (instant 503s —
    // not a cold start). Config kept intact; flip enabled (or PATCH via admin API) to
    // bring it back. Credentials stay bound in the Secrets Store.
    enabled: false,
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
