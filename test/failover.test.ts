/**
 * T7 429 failover, T8 500 failover, T9 timeout failover, T10 402 long cooldown,
 * T11 auth failure cooldown, T12 client error passthrough, T22 all providers down.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  CHAT_BODY,
  COMPLETION_BODY,
  activateFetchMock,
  chatRequest,
  deactivateFetchMock,
  mockUpstream,
  routerStub,
  seedProviders,
  statusMap,
} from "./helpers";

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

async function expectCompletionThrough(provider: string, times: number[]): Promise<void> {
  const res = await SELF.fetch(chatRequest(CHAT_BODY));
  expect(res.status).toBe(200);
  const body = (await res.json()) as typeof COMPLETION_BODY;
  expect(body.object).toBe("chat.completion");
  expect(times[0]).toBe(1);
}

describe("T7: HTTP 429 failover", () => {
  it("fails over to a healthy provider on rate limit", async () => {
    const seeded = await seedProviders({ a: {}, b: {} });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 429, body: { error: { message: "slow down" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    await expectCompletionThrough("b", bTimes);
    expect(aTimes[0]).toBe(1);

    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.lastFailureStatus).toBe(429);
    expect(snap.get("a")!.consecutiveFailures).toBe(1);
    expect(snap.get("b")!.lastSuccessAt).not.toBeNull();
  });
});

describe("T8: HTTP 500 failover", () => {
  it("fails over on transient server errors", async () => {
    const seeded = await seedProviders({ a: {}, b: {} });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 500, body: { error: { message: "boom" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    await expectCompletionThrough("b", bTimes);
    expect(aTimes[0]).toBe(1);
  });
});

describe("T9: timeout failover", () => {
  it("aborts a slow upstream and succeeds via the next provider", async () => {
    const seeded = await seedProviders({
      a: { timeoutMs: 100 },
      b: {},
    });
    const bTimes: number[] = [];
    // Aborted requests never reach the mock's reply fn, so provider A's attempt is
    // verified through DO state (failure recorded) instead of a call counter.
    mockUpstream(seeded.a.baseUrl, { body: COMPLETION_BODY, delayMs: 5_000 });
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof COMPLETION_BODY;
    expect(body.object).toBe("chat.completion");
    expect(bTimes[0]).toBe(1);

    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.consecutiveFailures).toBe(1);
    expect(snap.get("a")!.lastFailureStatus).toBeNull(); // timeout, not an HTTP status
    expect(snap.get("a")!.activeRequests).toBe(0);
  }, 20_000);
});

describe("T10: HTTP 402 — credit unavailable", () => {
  it("fails over and puts the provider into a long cooldown", async () => {
    const seeded = await seedProviders({
      a: { creditFailureCooldownMs: 10_000 },
      b: {},
    });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 402, body: { error: { message: "payment" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    // First request: a fails with 402, b serves.
    await expectCompletionThrough("b", bTimes);
    expect(aTimes[0]).toBe(1);

    const snap = await statusMap(routerStub());
    const a = snap.get("a")!;
    expect(a.status).toBe("cooldown");
    expect(a.cooldownUntil).not.toBeNull();
    expect(a.cooldownUntil!).toBeGreaterThan(Date.now());

    // Second request must skip the cooling provider entirely.
    const res2 = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res2.status).toBe(200);
    expect(aTimes[0]).toBe(1); // a NOT retried
    expect(bTimes[0]).toBe(2);
  });
});

describe("T11: upstream authentication failure", () => {
  it("records the config/auth failure, cools down, fails over", async () => {
    const seeded = await seedProviders({
      a: { authFailureCooldownMs: 10_000 },
      b: {},
    });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 401, body: { error: { message: "bad key" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    await expectCompletionThrough("b", bTimes);
    expect(aTimes[0]).toBe(1);

    const snap = await statusMap(routerStub());
    const a = snap.get("a")!;
    expect(a.status).toBe("cooldown");
    expect(a.lastFailureStatus).toBe(401);
    expect(a.cooldownUntil!).toBeGreaterThan(Date.now());
  });
});

describe("T12: upstream client error (400) is NOT a provider fault", () => {
  it("passes the upstream error through without failover or penalty", async () => {
    const seeded = await seedProviders({ a: {}, b: {} });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(
      seeded.a.baseUrl,
      {
        status: 400,
        body: {
          error: { message: "messages array too long", type: "invalid_request_error", code: "bad" },
        },
      },
      aTimes,
    );
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("messages array too long");

    expect(aTimes[0]).toBe(1);
    expect(bTimes[0]).toBeUndefined(); // never attempted — request is the client's fault

    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.consecutiveFailures).toBe(0); // no penalty
    expect(snap.get("a")!.status).toBe("healthy");
  });
});

describe("T22: all providers down", () => {
  it("returns an OpenAI-shaped 502 after attempting each provider once", async () => {
    const seeded = await seedProviders({ a: {}, b: {} });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 503, body: { error: { message: "overloaded" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { status: 503, body: { error: { message: "overloaded" } } }, bTimes);

    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("all_providers_failed");
    expect(aTimes[0]).toBe(1);
    expect(bTimes[0]).toBe(1);
  });

  it("returns 503 no_provider_available when nothing is enabled", async () => {
    await seedProviders({});
    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_provider_available");
  });
});
