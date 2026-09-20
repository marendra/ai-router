/**
 * Admin management of non-secret provider configuration under /internal/providers.
 * Requires GRUVIX_AI_ROUTER_ADMIN_KEY. Secret VALUES can never arrive here: only
 * env-var NAMES (apiKeyEnv / baseUrlEnv) are accepted and stored.
 */
import { getEnvVar, type Env } from "../config/env";
import type {
  AdminResult,
  AiRouterCoordinator,
  ProviderPatch,
} from "../durableObjects/AiRouterCoordinator";
import { errorResponse, invalidRequest, methodNotAllowed, notFound } from "../utils/errors";
import { log } from "../utils/logging";

function json(body: unknown, status = 200, requestId?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (requestId) headers["x-request-id"] = requestId;
  return new Response(JSON.stringify(body), { status, headers });
}

function adminError(result: AdminResult, requestId: string): Response {
  return json({ ok: false, error: result.error ?? "unknown error" }, 400, requestId);
}

export async function handleInternalProviders(
  req: Request,
  env: Env,
  url: URL,
  requestId: string,
): Promise<Response> {
  const stub = env.AI_ROUTER.getByName("gpt-oss-120b") as unknown as AiRouterCoordinator;
  const path = url.pathname.replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean); // ["internal", "providers", maybe id]

  if (segments.length === 2) {
    if (req.method === "GET") {
      const snapshot = await stub.listProviders();
      return json({ providers: snapshot.providers }, 200, requestId);
    }
    if (req.method === "POST") {
      let patch: unknown;
      try {
        patch = await req.json();
      } catch {
        return invalidRequest("Body must be valid JSON.");
      }
      if (typeof patch !== "object" || patch === null) {
        return invalidRequest("Body must be a JSON object.");
      }
      const result = await stub.upsertProvider({ ...(patch as ProviderPatch) });
      if (!result.ok) return adminError(result, requestId);
      log.info("admin_provider_upserted", { requestId, providerId: result.provider?.id ?? "?" });
      return json(result, 200, requestId);
    }
    return methodNotAllowed();
  }

  if (segments.length === 3) {
    const providerId = segments[2] as string;
    if (req.method === "GET") {
      const snapshot = await stub.listProviders();
      const provider = snapshot.providers.find((p) => p.id === providerId);
      if (!provider) return notFound();
      return json(provider, 200, requestId);
    }
    if (req.method === "PATCH") {
      let patch: unknown;
      try {
        patch = await req.json();
      } catch {
        return invalidRequest("Body must be valid JSON.");
      }
      if (typeof patch !== "object" || patch === null) {
        return invalidRequest("Body must be a JSON object.");
      }
      const result = await stub.upsertProvider({
        id: providerId,
        ...(patch as Omit<ProviderPatch, "id">),
      });
      if (!result.ok) return adminError(result, requestId);
      log.info("admin_provider_patched", { requestId, providerId });
      return json(result, 200, requestId);
    }
    if (req.method === "DELETE") {
      const result = await stub.deleteProvider(providerId);
      if (!result.ok) {
        return json({ ok: false, error: result.error }, 404, requestId);
      }
      log.info("admin_provider_deleted", {
        requestId,
        providerId,
        deleted: result.deleted === true,
        pendingDeletion: result.pendingDeletion === true,
      });
      return json(result, 200, requestId);
    }
    return methodNotAllowed();
  }

  return notFound();
}
