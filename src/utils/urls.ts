/**
 * Base URL convention: `${baseUrl}/chat/completions` must be the endpoint. baseUrl may be
 * "https://host/v1" or a provider-prefixed root like "https://host/v1/openai". Trailing
 * slashes are stripped so "/v1/v1/..." can never be produced.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const left = baseUrl.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return `${left}/${right}`;
}

/** URL-join against a provider that was configured with a trailing-slash-free root. */
export function upstreamChatCompletionsUrl(baseUrl: string): string {
  return joinUrl(baseUrl, "/chat/completions");
}
