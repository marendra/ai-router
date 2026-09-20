/**
 * Usage ledger extraction logic (pure functions).
 * The D1 write path itself is production-only (binding exists solely in env.production):
 * there the recorder is exercised end-to-end and verified with remote D1 queries —
 * see HANDOFF "Live smoke".
 */
import { describe, expect, it } from "vitest";
import {
  extractUsageFromCompletion,
  extractUsageFromSseDump,
} from "../src/usage/usageLedger";

describe("usage extraction (non-streaming)", () => {
  it("reads usage + finish_reason from a completion body", () => {
    const body = {
      id: "x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
    expect(extractUsageFromCompletion(body)).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      finishReason: "stop",
    });
  });

  it("returns nulls when usage is missing", () => {
    expect(extractUsageFromCompletion({ choices: [] })).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      finishReason: null,
    });
    expect(extractUsageFromCompletion("not an object")).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      finishReason: null,
    });
  });
});

describe("usage extraction (SSE dump)", () => {
  const sse =
    'data: {"id":"c1","choices":[{"delta":{"content":"he"}}]}\n\n' +
    'data: {"id":"c1","choices":[{"delta":{"content":"llo"}}]}\n\n' +
    'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n' +
    "data: [DONE]\n\n";

  it("harvests the usage-bearing final chunk", () => {
    expect(extractUsageFromSseDump(sse)).toEqual({
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
      finishReason: "stop",
    });
  });

  it("returns nulls for streams without usage", () => {
    expect(extractUsageFromSseDump('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      finishReason: null,
    });
  });

  it("finds usage in a long stream by scanning the tail", () => {
    const filler = "x".repeat(600_000);
    const dump = `data: {"pad":"${filler}"}\n\n${sse}`;
    expect(extractUsageFromSseDump(dump).totalTokens).toBe(13);
  });
});
