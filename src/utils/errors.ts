import type { OpenAiErrorBody } from "../types/openai";

/** OpenAI-shaped JSON error helpers. Never embed upstream bodies for provider faults. */

export function errorResponse(
  status: number,
  message: string,
  type: string,
  code: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: OpenAiErrorBody = { error: { message, type, code } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function unauthorized(message = "Invalid or missing API key."): Response {
  return errorResponse(401, message, "authentication_error", "invalid_api_key");
}

export function invalidRequest(message: string, code = "invalid_request_error"): Response {
  return errorResponse(400, message, "invalid_request_error", code);
}

export function modelNotSupported(model: string): Response {
  return errorResponse(
    404,
    `Model '${model}' is not supported by this router.`,
    "invalid_request_error",
    "model_not_supported",
  );
}

export function noProviderAvailable(): Response {
  return errorResponse(
    503,
    "No inference provider is currently available.",
    "service_unavailable",
    "no_provider_available",
  );
}

export function allProvidersFailed(detail: string): Response {
  return errorResponse(
    502,
    `All attempted inference providers failed. ${detail}`,
    "upstream_error",
    "all_providers_failed",
  );
}

export function internalError(message = "Internal router error."): Response {
  return errorResponse(500, message, "internal_error", "internal_error");
}

export function notFound(): Response {
  return errorResponse(404, "Unknown route.", "invalid_request_error", "not_found");
}

export function methodNotAllowed(): Response {
  return errorResponse(405, "Method not allowed.", "invalid_request_error", "method_not_allowed");
}
