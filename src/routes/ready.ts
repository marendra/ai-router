import { getEnvVar, type Env } from "../config/env";
import type { AiRouterCoordinator } from "../durableObjects/AiRouterCoordinator";
import { errorResponse } from "../utils/errors";

/** GET /health — process-level health only. Never pings upstream providers. */
export function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /ready — ready when at least one enabled provider's configuration (including
 * secret bindings) actually resolves in this environment. Cheap: one DO RPC, no
 * upstream pings. Env values are checked for presence, never logged.
 */
export async function handleReady(env: Env, requestId: string): Promise<Response> {
  const stub = env.AI_ROUTER.getByName("gpt-oss-120b") as unknown as AiRouterCoordinator;
  const { providers } = await stub.getReadiness();

  const servable = providers.filter((p) => {
    const hasUrl =
      (p.baseUrl !== null && p.baseUrl !== "") ||
      (p.baseUrlEnv !== null && getEnvVar(env, p.baseUrlEnv) !== undefined);
    const hasKey = p.apiKeyEnv === null || getEnvVar(env, p.apiKeyEnv) !== undefined;
    return hasUrl && hasKey;
  });

  const ready = servable.length > 0;
  const headers = { "Content-Type": "application/json", "x-request-id": requestId };
  if (ready) {
    return new Response(
      JSON.stringify({ status: "ready", servableProviders: servable.map((p) => p.id) }),
      { status: 200, headers },
    );
  }
  const notReady = errorResponse(
    503,
    "No provider is currently configured and resolvable.",
    "service_unavailable",
    "not_ready",
  );
  const notReadyHeaders = new Headers(notReady.headers);
  notReadyHeaders.set("x-request-id", requestId);
  return new Response(notReady.body, { status: notReady.status, headers: notReadyHeaders });
}
