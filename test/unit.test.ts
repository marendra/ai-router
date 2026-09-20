import { describe, expect, it } from "vitest";
import {
  classifyFetchError,
  classifyUpstreamStatus,
  cooldownClass,
  isPenalizing,
  shouldFailover,
} from "../src/router/failureClassifier";
import { joinUrl, upstreamChatCompletionsUrl } from "../src/utils/urls";
import { bearerToken, timingSafeEqual } from "../src/utils/security";
import { resolveRequestId } from "../src/utils/requestId";

describe("failure classification", () => {
  it("maps upstream status codes to failure classes", () => {
    expect(classifyUpstreamStatus(400)).toBe("client_error");
    expect(classifyUpstreamStatus(422)).toBe("client_error");
    expect(classifyUpstreamStatus(401)).toBe("authentication_error");
    expect(classifyUpstreamStatus(403)).toBe("authentication_error");
    expect(classifyUpstreamStatus(402)).toBe("credit_error");
    expect(classifyUpstreamStatus(404)).toBe("model_configuration_error");
    expect(classifyUpstreamStatus(408)).toBe("timeout");
    expect(classifyUpstreamStatus(429)).toBe("rate_limit");
    expect(classifyUpstreamStatus(500)).toBe("provider_overloaded");
    expect(classifyUpstreamStatus(503)).toBe("provider_overloaded");
    expect(classifyUpstreamStatus(529)).toBe("provider_overloaded");
    expect(classifyUpstreamStatus(502)).toBe("provider_error");
    expect(classifyUpstreamStatus(504)).toBe("provider_error");
    expect(classifyUpstreamStatus(418)).toBe("unknown");
  });

  it("failover policy covers transient/provider classes only", () => {
    for (const cls of [
      "network_error",
      "timeout",
      "rate_limit",
      "provider_overloaded",
      "provider_error",
      "credit_error",
      "authentication_error",
      "model_configuration_error",
    ] as const) {
      expect(shouldFailover(cls)).toBe(true);
    }
    for (const cls of ["client_error", "client_abort", "stream_interrupted"] as const) {
      expect(shouldFailover(cls)).toBe(false);
    }
  });

  it("client faults and aborts are not penalizing", () => {
    expect(isPenalizing("client_error")).toBe(false);
    expect(isPenalizing("client_abort")).toBe(false);
    expect(isPenalizing("rate_limit")).toBe(true);
    expect(isPenalizing("timeout")).toBe(true);
  });

  it("auth/model/credit failures use long cooldowns", () => {
    expect(cooldownClass("authentication_error")).toBe("auth");
    expect(cooldownClass("model_configuration_error")).toBe("auth");
    expect(cooldownClass("credit_error")).toBe("credit");
    expect(cooldownClass("rate_limit")).toBe("normal");
  });

  it("classifies fetch errors: timeout vs network vs client abort", () => {
    expect(classifyFetchError(new DOMException("t", "TimeoutError"), false)).toBe("timeout");
    expect(classifyFetchError(new DOMException("a", "AbortError"), false)).toBe("timeout");
    expect(classifyFetchError(new Error("socket hung up"), false)).toBe("network_error");
    expect(classifyFetchError(new Error("whatever"), true)).toBe("client_abort");
  });
});

describe("url joining", () => {
  it("never produces /v1/v1 and tolerates trailing slashes", () => {
    expect(upstreamChatCompletionsUrl("https://p.test/v1")).toBe(
      "https://p.test/v1/chat/completions",
    );
    expect(upstreamChatCompletionsUrl("https://p.test/v1/")).toBe(
      "https://p.test/v1/chat/completions",
    );
    expect(upstreamChatCompletionsUrl("https://p.test/v1/openai")).toBe(
      "https://p.test/v1/openai/chat/completions",
    );
    expect(joinUrl("https://p.test//", "chat/completions")).toBe(
      "https://p.test/chat/completions",
    );
  });
});

describe("security utils", () => {
  it("timing-safe compare", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secreT")).toBe(false);
    expect(timingSafeEqual("short", "longer-string")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
    expect(timingSafeEqual("x", "")).toBe(false);
  });

  it("parses bearer tokens only", () => {
    const req = (auth: string | null): Request =>
      new Request("http://x/", {
        headers: auth ? { Authorization: auth } : undefined,
      });
    expect(bearerToken(req("Bearer abc"))).toBe("abc");
    expect(bearerToken(req("bearer abc"))).toBe("abc");
    expect(bearerToken(req("Basic abc"))).toBeNull();
    expect(bearerToken(req(null))).toBeNull();
  });
});

describe("request id", () => {
  it("honors sane incoming ids, rejects junk, generates otherwise", () => {
    const withId = new Request("http://x/", { headers: { "x-request-id": "req-abc_123" } });
    expect(resolveRequestId(withId)).toBe("req-abc_123");

    const junk = new Request("http://x/", { headers: { "x-request-id": "bad id!!" } });
    expect(resolveRequestId(junk)).toMatch(/^[0-9a-f-]{36}$/);

    const none = new Request("http://x/");
    expect(resolveRequestId(none)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
