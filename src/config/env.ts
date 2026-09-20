/** Worker environment: bindings, vars and dynamic secret lookup. */

/** Keys a provider may reference via apiKeyEnv/baseUrlEnv. Resolved dynamically. */
export interface Env {
  AI_ROUTER: DurableObjectNamespace;

  // --- secrets (set via `wrangler secret put`) ---
  GRUVIX_AI_ROUTER_KEY?: string;
  GRUVIX_AI_ROUTER_ADMIN_KEY?: string;
  DEEPINFRA_API_KEY?: string;
  AKASHML_API_KEY?: string;
  MODAL_API_KEY?: string;
  MODAL_BASE_URL?: string;

  // --- vars (wrangler.jsonc) ---
  LOG_LEVEL?: string;
  ROUTER_DEBUG_HEADERS?: string;
  MAX_PROVIDER_ATTEMPTS?: string;
  LEASE_TTL_MS?: string;

  // Providers reference secrets by NAME (apiKeyEnv), so the worker must allow
  // dynamic lookup. Values are never copied into config, storage or logs.
  [key: string]: unknown;
}

export function getEnvVar(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
