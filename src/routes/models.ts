import { LOGICAL_MODEL } from "../config/defaults";

/** GET /v1/models — OpenAI-compatible list exposing ONLY the logical model. */
export function handleModels(requestId: string): Response {
  const body = {
    object: "list",
    data: [
      {
        id: LOGICAL_MODEL,
        object: "model",
        created: 1735689600, // fixed placeholder; logical models are static
        owned_by: "gruuvix-ai-router",
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "x-request-id": requestId },
  });
}
