/**
 * AiRouterCoordinator — ONE Durable Object instance per logical model.
 *
 * Coordination only: provider registry (non-secret config), runtime health state,
 * expiring leases, round-robin cursor. It NEVER touches LLM payloads.
 *
 * Consistency model: DO inputs are serialized on a single thread; every RPC performs its
 * read → mutate → persist sequence with NO await inside, so concurrent Workers can never
 * interleave mid-transaction (e.g. double-book a provider's concurrency limit).
 * SQLite is the only source of truth — hibernation/eviction is a non-event.
 */
import { DurableObject } from "cloudflare:workers";
import { DEFAULT_PROVIDER_SEED, LOGICAL_MODEL } from "../config/defaults";
import type {
  Lease,
  ProviderConfig,
  ProviderRuntimeState,
  ProviderStatusView,
} from "../types/provider";
import type {
  AcquireProviderRequest,
  AcquireProviderResult,
  ReportFailureRequest,
  ReportSuccessRequest,
} from "../types/router";
import {
  activeCountsByProvider,
  countActiveLeases,
  deleteLease,
  insertLease,
  purgeExpiredLeases,
} from "../router/leaseManager";
import {
  effectiveStatus,
  initialState,
  isEligible,
  toStatusView,
} from "../router/providerState";
import { cooldownClass, isPenalizing } from "../router/failureClassifier";
import { DEFAULT_LEASE_TTL_MS } from "../config/defaults";

const CURSOR_KEY = "round_robin_cursor";

// ---------------------------------------------------------------- schema

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  base_url TEXT,
  base_url_env TEXT,
  model_id TEXT NOT NULL,
  api_key_env TEXT,
  timeout_ms INTEGER NOT NULL,
  stream_idle_timeout_ms INTEGER NOT NULL,
  cooldown_ms INTEGER NOT NULL,
  auth_failure_cooldown_ms INTEGER NOT NULL,
  credit_failure_cooldown_ms INTEGER NOT NULL,
  failure_threshold INTEGER NOT NULL,
  max_concurrent_requests INTEGER NOT NULL,
  pending_deletion INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_state (
  provider_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'healthy',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  half_open_probe_active INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_failure_status INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_provider ON leases (provider_id);
CREATE TABLE IF NOT EXISTS router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface ProviderRow {
  id: string;
  enabled: number;
  base_url: string | null;
  base_url_env: string | null;
  model_id: string;
  api_key_env: string | null;
  timeout_ms: number;
  stream_idle_timeout_ms: number;
  cooldown_ms: number;
  auth_failure_cooldown_ms: number;
  credit_failure_cooldown_ms: number;
  failure_threshold: number;
  max_concurrent_requests: number;
  pending_deletion: number;
  created_at: number;
  updated_at: number;
}

interface StateRow {
  provider_id: string;
  status: string;
  consecutive_failures: number;
  cooldown_until: number | null;
  half_open_probe_active: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_status: number | null;
}

function rowToConfig(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    enabled: row.enabled === 1,
    baseUrl: row.base_url,
    baseUrlEnv: row.base_url_env,
    modelId: row.model_id,
    apiKeyEnv: row.api_key_env,
    timeoutMs: row.timeout_ms,
    streamIdleTimeoutMs: row.stream_idle_timeout_ms,
    cooldownMs: row.cooldown_ms,
    authFailureCooldownMs: row.auth_failure_cooldown_ms,
    creditFailureCooldownMs: row.credit_failure_cooldown_ms,
    failureThreshold: row.failure_threshold,
    maxConcurrentRequests: row.max_concurrent_requests,
    pendingDeletion: row.pending_deletion === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToState(row: StateRow): ProviderRuntimeState {
  return {
    providerId: row.provider_id,
    status: row.status === "cooldown" ? "cooldown" : "healthy",
    consecutiveFailures: row.consecutive_failures,
    cooldownUntil: row.cooldown_until,
    halfOpenProbeActive: row.half_open_probe_active === 1,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureStatus: row.last_failure_status,
  };
}

// ---------------------------------------------------------------- admin payloads

export interface ProviderPatch {
  id: string;
  enabled?: boolean;
  baseUrl?: string | null;
  baseUrlEnv?: string | null;
  modelId?: string;
  apiKeyEnv?: string | null;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  cooldownMs?: number;
  authFailureCooldownMs?: number;
  creditFailureCooldownMs?: number;
  failureThreshold?: number;
  maxConcurrentRequests?: number;
}

export interface AdminResult {
  ok: boolean;
  error?: string;
  provider?: ProviderStatusView;
  deleted?: boolean;
  pendingDeletion?: boolean;
  activeLeases?: number;
}

export class AiRouterCoordinator extends DurableObject<Record<string, unknown>> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent, synchronous bootstrap: schema + first-run seed of default providers.
    this.sql.exec(SCHEMA);
    const seededRows = [
      ...this.sql.exec("SELECT COUNT(*) AS n FROM providers"),
    ] as { n: number }[];
    const seeded = seededRows[0] as { n: number };
    if (seeded.n === 0) {
      const now = Date.now();
      for (const seed of DEFAULT_PROVIDER_SEED) {
        const cfg: ProviderConfig = {
          ...seed,
          baseUrl: seed.baseUrl,
          pendingDeletion: false,
          createdAt: now,
          updatedAt: now,
        };
        this.writeConfig(cfg);
        this.writeState(initialState(cfg.id));
      }
    }
  }

  // ------------------------------------------------------------ persistence

  private writeConfig(cfg: ProviderConfig): void {
    this.sql.exec(
      `INSERT INTO providers (
        id, enabled, base_url, base_url_env, model_id, api_key_env,
        timeout_ms, stream_idle_timeout_ms, cooldown_ms, auth_failure_cooldown_ms,
        credit_failure_cooldown_ms, failure_threshold, max_concurrent_requests,
        pending_deletion, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        enabled=excluded.enabled, base_url=excluded.base_url, base_url_env=excluded.base_url_env,
        model_id=excluded.model_id, api_key_env=excluded.api_key_env, timeout_ms=excluded.timeout_ms,
        stream_idle_timeout_ms=excluded.stream_idle_timeout_ms, cooldown_ms=excluded.cooldown_ms,
        auth_failure_cooldown_ms=excluded.auth_failure_cooldown_ms,
        credit_failure_cooldown_ms=excluded.credit_failure_cooldown_ms,
        failure_threshold=excluded.failure_threshold,
        max_concurrent_requests=excluded.max_concurrent_requests,
        pending_deletion=excluded.pending_deletion, updated_at=excluded.updated_at`,
      cfg.id,
      cfg.enabled ? 1 : 0,
      cfg.baseUrl,
      cfg.baseUrlEnv,
      cfg.modelId,
      cfg.apiKeyEnv,
      cfg.timeoutMs,
      cfg.streamIdleTimeoutMs,
      cfg.cooldownMs,
      cfg.authFailureCooldownMs,
      cfg.creditFailureCooldownMs,
      cfg.failureThreshold,
      cfg.maxConcurrentRequests,
      cfg.pendingDeletion ? 1 : 0,
      cfg.createdAt,
      cfg.updatedAt,
    );
  }

  private writeState(state: ProviderRuntimeState): void {
    this.sql.exec(
      `INSERT INTO provider_state (
        provider_id, status, consecutive_failures, cooldown_until, half_open_probe_active,
        last_success_at, last_failure_at, last_failure_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        status=excluded.status, consecutive_failures=excluded.consecutive_failures,
        cooldown_until=excluded.cooldown_until, half_open_probe_active=excluded.half_open_probe_active,
        last_success_at=excluded.last_success_at, last_failure_at=excluded.last_failure_at,
        last_failure_status=excluded.last_failure_status`,
      state.providerId,
      state.status,
      state.consecutiveFailures,
      state.cooldownUntil,
      state.halfOpenProbeActive ? 1 : 0,
      state.lastSuccessAt,
      state.lastFailureAt,
      state.lastFailureStatus,
    );
  }

  private loadConfigs(): ProviderConfig[] {
    const rows = [...this.sql.exec("SELECT * FROM providers ORDER BY id")] as unknown as ProviderRow[];
    return rows.map(rowToConfig);
  }

  private loadConfig(id: string): ProviderConfig | null {
    const rows = [
      ...this.sql.exec("SELECT * FROM providers WHERE id = ?", id),
    ] as unknown as ProviderRow[];
    const row = rows[0];
    return row ? rowToConfig(row) : null;
  }

  private loadState(id: string): ProviderRuntimeState {
    const rows = [
      ...this.sql.exec("SELECT * FROM provider_state WHERE provider_id = ?", id),
    ] as unknown as StateRow[];
    const row = rows[0];
    return row ? rowToState(row) : initialState(id);
  }

  /** Lazy housekeeping at the top of routing RPCs: expire leases, drop drained deletes. */
  private housekeeping(now: number): void {
    purgeExpiredLeases(this.sql, now);
    this.sql.exec(
      `DELETE FROM providers WHERE pending_deletion = 1 AND id NOT IN
       (SELECT DISTINCT provider_id FROM leases)`,
    );
    this.sql.exec(
      `DELETE FROM provider_state WHERE provider_id NOT IN (SELECT id FROM providers)`,
    );
    this.sql.exec(
      `DELETE FROM leases WHERE provider_id NOT IN (SELECT id FROM providers)`,
    );
  }

  private getCursor(): number {
    const rows = [
      ...this.sql.exec("SELECT value FROM router_state WHERE key = ?", CURSOR_KEY),
    ] as { value: string }[];
    const row = rows[0];
    return row ? Number.parseInt(row.value, 10) : -1;
  }

  private setCursor(index: number): void {
    this.sql.exec(
      `INSERT INTO router_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      CURSOR_KEY,
      String(index),
    );
  }

  // ------------------------------------------------------------ routing RPCs

  /**
   * Atomic provider acquisition: purge → evaluate eligibility → grant lease → advance
   * cursor. All synchronous (zero awaits) so the DO's serialized execution makes this
   * transactional. Returns the non-secret config snapshot the Worker needs upstream.
   */
  async acquireProvider(request: AcquireProviderRequest): Promise<AcquireProviderResult> {
    const now = Date.now();
    this.housekeeping(now);

    const excluded = new Set(request.excludeProviderIds ?? []);
    const configs = this.loadConfigs();
    const counts = activeCountsByProvider(this.sql);

    const eligible: number[] = [];
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i] as ProviderConfig;
      const state = this.loadState(cfg.id);
      if (isEligible({ cfg, state, activeRequests: counts.get(cfg.id) ?? 0, now, excluded })) {
        eligible.push(i);
      }
    }
    if (eligible.length === 0) {
      return { ok: false, reason: "no_provider_available" };
    }

    // Round robin over the sorted full list: start after the persisted cursor index,
    // wrapping back to the first eligible provider.
    const cursor = this.getCursor();
    let pick = eligible[0] as number;
    if (cursor >= 0) {
      const next = eligible.find((idx) => idx > cursor);
      if (next !== undefined) pick = next;
    }

    const cfg = configs[pick] as ProviderConfig;
    const leaseTtlMs =
      request.leaseTtlMs !== undefined && request.leaseTtlMs > 0
        ? request.leaseTtlMs
        : DEFAULT_LEASE_TTL_MS;
    const lease: Lease = {
      leaseId: crypto.randomUUID(),
      providerId: cfg.id,
      requestId: request.requestId,
      createdAt: now,
      expiresAt: now + leaseTtlMs,
    };
    insertLease(this.sql, lease);

    // Half-open probe now in flight: block further probes until this lease resolves.
    const state = this.loadState(cfg.id);
    if (effectiveStatus(state, now) === "half_open") {
      state.halfOpenProbeActive = true;
      this.writeState(state);
    }

    this.setCursor(pick);

    return {
      ok: true,
      providerId: cfg.id,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt,
      config: {
        id: cfg.id,
        baseUrl: cfg.baseUrl,
        baseUrlEnv: cfg.baseUrlEnv,
        modelId: cfg.modelId,
        apiKeyEnv: cfg.apiKeyEnv,
        timeoutMs: cfg.timeoutMs,
        streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
      },
    };
  }

  async reportSuccess(request: ReportSuccessRequest): Promise<{ released: boolean }> {
    const now = Date.now();
    this.housekeeping(now);
    // Delete-first makes this idempotent: a second report is a harmless no-op.
    if (!deleteLease(this.sql, request.leaseId)) return { released: false };
    const cfg = this.loadConfig(request.providerId);
    if (!cfg) return { released: true };
    const state = this.loadState(cfg.id);
    state.consecutiveFailures = 0;
    state.status = "healthy";
    state.cooldownUntil = null;
    state.halfOpenProbeActive = false;
    state.lastSuccessAt = now;
    this.writeState(state);
    return { released: true };
  }

  async reportFailure(request: ReportFailureRequest): Promise<{ released: boolean }> {
    const now = Date.now();
    this.housekeeping(now);
    if (!deleteLease(this.sql, request.leaseId)) return { released: false };
    if (!isPenalizing(request.failureClass)) return { released: true };

    const cfg = this.loadConfig(request.providerId);
    if (!cfg) return { released: true };
    const state = this.loadState(cfg.id);

    const wasProbe = state.halfOpenProbeActive;
    state.halfOpenProbeActive = false;
    state.consecutiveFailures += 1;
    state.lastFailureAt = now;
    state.lastFailureStatus = request.status;

    // A failed half-open probe trips immediately. Account/config faults (auth, credit,
    // broken model config) are deterministic — trip on the FIRST occurrence. Transient
    // classes honor the configured consecutive-failure threshold.
    const kind = cooldownClass(request.failureClass);
    const trips =
      wasProbe || kind !== "normal" || state.consecutiveFailures >= cfg.failureThreshold;
    if (trips) {
      state.status = "cooldown";
      const kind = cooldownClass(request.failureClass);
      const ms =
        kind === "auth"
          ? cfg.authFailureCooldownMs
          : kind === "credit"
            ? cfg.creditFailureCooldownMs
            : cfg.cooldownMs;
      state.cooldownUntil = now + ms;
    }
    this.writeState(state);
    return { released: true };
  }

  // ------------------------------------------------------------ status / admin RPCs

  async listProviders(): Promise<{ providers: ProviderStatusView[]; now: number }> {
    const now = Date.now();
    this.housekeeping(now);
    const configs = this.loadConfigs();
    const counts = activeCountsByProvider(this.sql);
    const providers = configs.map((cfg) => {
      const state = this.loadState(cfg.id);
      const view = toStatusView(cfg, state, counts.get(cfg.id) ?? 0, now);
      if (!cfg.enabled) view.status = "disabled";
      return view;
    });
    return { providers, now };
  }

  /**
   * Readiness inputs: enabled, non-draining providers with their env-var NAMES (never
   * values). The Worker checks whether those bindings actually resolve.
   */
  async getReadiness(): Promise<{
    providers: {
      id: string;
      baseUrl: string | null;
      baseUrlEnv: string | null;
      apiKeyEnv: string | null;
    }[];
  }> {
    this.housekeeping(Date.now());
    const configs = this.loadConfigs();
    return {
      providers: configs
        .filter((cfg) => cfg.enabled && !cfg.pendingDeletion)
        .map((cfg) => ({
          id: cfg.id,
          baseUrl: cfg.baseUrl,
          baseUrlEnv: cfg.baseUrlEnv,
          apiKeyEnv: cfg.apiKeyEnv,
        })),
    };
  }

  async upsertProvider(patch: ProviderPatch): Promise<AdminResult> {
    const now = Date.now();
    this.housekeeping(now);

    const id = patch.id?.trim().toLowerCase();
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      return { ok: false, error: "Provider id must match [a-z0-9][a-z0-9_-]{0,63}." };
    }
    const existing = this.loadConfig(id);

    const envName = (v: unknown): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v)) return v;
      return undefined; // invalid → caught below via sentinel check
    };

    const baseUrlEnv = envName(patch.baseUrlEnv);
    const apiKeyEnv = envName(patch.apiKeyEnv);
    if (patch.baseUrlEnv !== undefined && baseUrlEnv === undefined) {
      return { ok: false, error: "baseUrlEnv must be null or an ENV_VAR_NAME." };
    }
    if (patch.apiKeyEnv !== undefined && apiKeyEnv === undefined) {
      return { ok: false, error: "apiKeyEnv must be null or an ENV_VAR_NAME (never a secret value)." };
    }
    if (patch.baseUrl !== undefined && patch.baseUrl !== null) {
      if (typeof patch.baseUrl !== "string" || !/^https?:\/\//.test(patch.baseUrl)) {
        return { ok: false, error: "baseUrl must be an http(s) URL." };
      }
    }

    const positive = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const timeoutMs = patch.timeoutMs !== undefined ? positive(patch.timeoutMs) : undefined;
    if (patch.timeoutMs !== undefined && timeoutMs === undefined) {
      return { ok: false, error: "timeoutMs must be a positive number." };
    }
    const streamIdleTimeoutMs =
      patch.streamIdleTimeoutMs !== undefined ? positive(patch.streamIdleTimeoutMs) : undefined;
    if (patch.streamIdleTimeoutMs !== undefined && streamIdleTimeoutMs === undefined) {
      return { ok: false, error: "streamIdleTimeoutMs must be a positive number." };
    }
    const cooldownMs = patch.cooldownMs !== undefined ? positive(patch.cooldownMs) : undefined;
    const authFailureCooldownMs =
      patch.authFailureCooldownMs !== undefined ? positive(patch.authFailureCooldownMs) : undefined;
    const creditFailureCooldownMs =
      patch.creditFailureCooldownMs !== undefined
        ? positive(patch.creditFailureCooldownMs)
        : undefined;
    const failureThreshold = patch.failureThreshold !== undefined ? positive(patch.failureThreshold) : undefined;
    const maxConcurrentRequests =
      patch.maxConcurrentRequests !== undefined ? positive(patch.maxConcurrentRequests) : undefined;

    if (!existing) {
      if (patch.baseUrl === undefined && baseUrlEnv === undefined) {
        return { ok: false, error: "New provider requires baseUrl or baseUrlEnv." };
      }
      if (typeof patch.modelId !== "string" || patch.modelId.length === 0) {
        return { ok: false, error: "New provider requires modelId." };
      }
    }

    const cfg: ProviderConfig = existing
      ? { ...existing }
      : {
          id,
          enabled: true,
          baseUrl: null,
          baseUrlEnv: null,
          modelId: patch.modelId as string,
          apiKeyEnv: null,
          timeoutMs: 60_000,
          streamIdleTimeoutMs: 60_000,
          cooldownMs: 30_000,
          authFailureCooldownMs: 900_000,
          creditFailureCooldownMs: 1_800_000,
          failureThreshold: 2,
          maxConcurrentRequests: 20,
          pendingDeletion: false,
          createdAt: now,
          updatedAt: now,
        };

    if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
    if (patch.baseUrl !== undefined) cfg.baseUrl = patch.baseUrl;
    if (baseUrlEnv !== undefined) cfg.baseUrlEnv = baseUrlEnv;
    if (typeof patch.modelId === "string" && patch.modelId.length > 0) cfg.modelId = patch.modelId;
    if (apiKeyEnv !== undefined) cfg.apiKeyEnv = apiKeyEnv;
    if (timeoutMs !== undefined) cfg.timeoutMs = timeoutMs;
    if (streamIdleTimeoutMs !== undefined) cfg.streamIdleTimeoutMs = streamIdleTimeoutMs;
    if (cooldownMs !== undefined) cfg.cooldownMs = cooldownMs;
    if (authFailureCooldownMs !== undefined) cfg.authFailureCooldownMs = authFailureCooldownMs;
    if (creditFailureCooldownMs !== undefined) cfg.creditFailureCooldownMs = creditFailureCooldownMs;
    if (failureThreshold !== undefined) cfg.failureThreshold = Math.floor(failureThreshold);
    if (maxConcurrentRequests !== undefined) {
      cfg.maxConcurrentRequests = Math.floor(maxConcurrentRequests);
    }
    cfg.updatedAt = now;

    this.writeConfig(cfg);

    // Keep runtime state coherent with enable/disable flips.
    const state = this.loadState(id);
    if (patch.enabled === true) {
      state.status = "healthy";
      state.cooldownUntil = null;
      state.halfOpenProbeActive = false;
      state.consecutiveFailures = 0;
      this.writeState(state);
    } else if (patch.enabled === false) {
      state.halfOpenProbeActive = false;
      this.writeState(state);
    }

    const counts = activeCountsByProvider(this.sql);
    const view = toStatusView(cfg, this.loadState(id), counts.get(id) ?? 0, now);
    if (!cfg.enabled) view.status = "disabled";
    return { ok: true, provider: view };
  }

  async deleteProvider(id: string): Promise<AdminResult> {
    const now = Date.now();
    this.housekeeping(now);
    const cfg = this.loadConfig(id);
    if (!cfg) return { ok: false, error: `Unknown provider '${id}'.` };
    const active = countActiveLeases(this.sql, id);
    if (active > 0) {
      // Keep lease accounting intact: drain first, rows disappear via housekeeping.
      const drained: ProviderConfig = { ...cfg, enabled: false, pendingDeletion: true, updatedAt: now };
      this.writeConfig(drained);
      const state = this.loadState(id);
      state.halfOpenProbeActive = false;
      this.writeState(state);
      return { ok: true, deleted: false, pendingDeletion: true, activeLeases: active };
    }
    this.sql.exec("DELETE FROM providers WHERE id = ?", id);
    this.sql.exec("DELETE FROM provider_state WHERE provider_id = ?", id);
    this.sql.exec("DELETE FROM leases WHERE provider_id = ?", id);
    return { ok: true, deleted: true, pendingDeletion: false, activeLeases: 0 };
  }

  /** For tests/debug: the logical model this coordinator instance serves. */
  async getLogicalModel(): Promise<string> {
    return LOGICAL_MODEL;
  }
}
