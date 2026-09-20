/**
 * Gruuvix AI Router — Worker entry.
 *
 * Routing table:
 *   POST /v1/chat/completions   (router key)  — OpenAI-compatible inference with failover
 *   GET  /v1/models             (router key)  — logical model list only
 *   GET  /health                              — liveness, no upstream calls
 *   GET  /ready                              — readiness, DO-backed, no upstream calls
 *   /internal/providers[/:id]   (admin key)   — provider status + non-secret config CRUD
 *
 * Never logs prompts, completions, or secrets. Upstream Authorization headers are
 * constructed from provider secrets; the client's header is never forwarded.
 */
import { requireAdminKey } from "./auth/adminAuth";
import { requireRouterKey } from "./auth/routerAuth";
import { getEnvVar, resolveSecret, type Env } from "./config/env";
import { AiRouterCoordinator } from "./durableObjects/AiRouterCoordinator";
import { handleChatCompletions } from "./routes/chatCompletions";
import { handleHealth } from "./routes/health";
import { handleInternalProviders } from "./routes/internalProviders";
import { handleModels } from "./routes/models";
import { handleReady } from "./routes/ready";
import { internalError, notFound } from "./utils/errors";
import { log, setLogLevel } from "./utils/logging";
import { resolveRequestId } from "./utils/requestId";

export { AiRouterCoordinator };

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setLogLevel(getEnvVar(env, "LOG_LEVEL") ?? env.LOG_LEVEL);
    const requestId = resolveRequestId(req);

    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health" && req.method === "GET") {
        return handleHealth();
      }

      if (path === "/ready" && req.method === "GET") {
        return handleReady(env, requestId);
      }

      if (path === "/v1/models" && req.method === "GET") {
        const denied = requireRouterKey(req, await resolveSecret(env, "GRUVIX_AI_ROUTER_KEY"));
        if (denied) return withRequestId(denied, requestId);
        return handleModels(requestId);
      }

      if (path === "/v1/chat/completions" && req.method === "POST") {
        const denied = requireRouterKey(req, await resolveSecret(env, "GRUVIX_AI_ROUTER_KEY"));
        if (denied) return withRequestId(denied, requestId);
        return await handleChatCompletions(req, env, ctx, requestId);
      }

      if (path === "/internal/providers" || path.startsWith("/internal/providers/")) {
        const denied = requireAdminKey(req, await resolveSecret(env, "GRUVIX_AI_ROUTER_ADMIN_KEY"));
        if (denied) return withRequestId(denied, requestId);
        return await handleInternalProviders(req, env, url, requestId);
      }

      return withRequestId(notFound(), requestId);
    } catch (err) {
      // Metadata only. Error messages we construct never contain secrets or payloads.
      log.error("unhandled_error", {
        requestId,
        path: new URL(req.url).pathname,
        message: err instanceof Error ? err.message : "unknown",
      });
      return withRequestId(internalError(), requestId);
    }
  },
};

export type { Env };
