/**
 * ONE generic OpenAI-compatible upstream adapter. Provider differences live entirely in
 * configuration (base URL, model id, key env). No per-provider client files.
 *
 * Headers are constructed intentionally: the client's Authorization header is NEVER
 * forwarded; upstream auth uses the selected provider's resolved secret only.
 */
import type { ProviderConfigSnapshot } from "../types/router";
import { upstreamChatCompletionsUrl } from "../utils/urls";

export interface CallProviderArgs {
  config: ProviderConfigSnapshot;
  resolvedBaseUrl: string;
  apiKey: string | undefined;
  /** Request body with the logical model already rewritten to the provider model id. */
  body: Record<string, unknown>;
  /** Aborts connect + time-to-first-response (headers). */
  signal: AbortSignal;
}

export function buildUpstreamHeaders(apiKey: string | undefined, streaming: boolean): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Accept", streaming ? "text/event-stream" : "application/json");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

export async function callProvider(args: CallProviderArgs): Promise<Response> {
  const streaming = args.body.stream === true;
  return fetch(upstreamChatCompletionsUrl(args.resolvedBaseUrl), {
    method: "POST",
    headers: buildUpstreamHeaders(args.apiKey, streaming),
    body: JSON.stringify(args.body),
    signal: args.signal,
  });
}
