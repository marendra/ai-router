/** Minimal OpenAI wire shapes the router actually inspects. Unknown fields pass through. */

export type ChatCompletionRequestBody = Record<string, unknown> & {
  model: string;
  messages: unknown[];
  stream?: boolean;
};

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
  };
}
