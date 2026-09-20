/**
 * T1 round robin, T3 disabled provider, T4 concurrency limit, T20 model rewrite,
 * T21 provider never attempted twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  CHAT_BODY,
  COMPLETION_BODY,
  acquire,
  activateFetchMock,
  chatRequest,
  deactivateFetchMock,
  mockUpstream,
  routerStub,
  seedProviders,
} from "./helpers";
import type { AcquireProviderResult } from "../src/types/router";

function providerId(r: AcquireProviderResult): string {
  if (!r.ok) throw new Error(`expected acquisition, got ${r.reason}`);
  return r.providerId;
}

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

describe("T1: basic health-aware round robin", () => {
  it("rotates a→b→c→a→b→c across acquires", async () => {
    await seedProviders({ a: {}, b: {}, c: {} });
    const stub = routerStub();
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      picks.push(providerId(await acquire(stub)));
    }
    expect(picks).toEqual(["a", "b", "c", "a", "b", "c"]);
  });
});

describe("T3: disabled provider is skipped", () => {
  it("rotates only enabled providers", async () => {
    await seedProviders({ a: {}, b: { enabled: false }, c: {} });
    const stub = routerStub();
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      picks.push(providerId(await acquire(stub)));
    }
    expect(picks).toEqual(["a", "c", "a", "c"]);
  });
});

describe("T4: concurrency limit", () => {
  it("skips a provider at capacity and returns to it after release", async () => {
    await seedProviders({
      a: { maxConcurrentRequests: 1 },
      b: {},
      c: {},
    });
    const stub = routerStub();

    const first = await acquire(stub);
    if (!first.ok) throw new Error("acquire failed");
    expect(first.providerId).toBe("a");

    // a is now at capacity (1/1): next pick must skip it.
    const second = await acquire(stub);
    const secondId = providerId(second);
    expect(secondId).not.toBe("a");
    expect(["b", "c"]).toContain(secondId);

    const third = await acquire(stub);
    expect(providerId(third)).not.toBe("a");

    // Release the original lease: a becomes eligible again.
    await stub.reportSuccess({ leaseId: first.leaseId, providerId: "a" });    const fourth = await acquire(stub);
    expect(providerId(fourth)).toBe("a");
  });
});

describe("T20: model rewrite", () => {
  it("sends the provider model id upstream while Gruuvix keeps the logical model", async () => {
    const seeded = await seedProviders({ a: { modelId: "provider-a-model" } });
    const times: number[] = [];
    let capturedBody = "";
    mockUpstream(
      seeded.a.baseUrl,
      {
        body: COMPLETION_BODY,
        onRequest: (raw) => {
          capturedBody = raw;
        },
      },
      times,
    );

    const res = await SELF.fetch(
      chatRequest({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();

    const sent = JSON.parse(capturedBody) as { model: string; messages: unknown[] };
    expect(sent.model).toBe("provider-a-model");
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(times[0]).toBe(1);
  });
});

describe("T21: provider is never attempted twice in one request", () => {
  it("excludes failed providers from later attempts", async () => {
    const seeded = await seedProviders({ a: {}, b: {} });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 500, body: { error: { message: "boom" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { status: 500, body: { error: { message: "boom" } } }, bTimes);

    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    // Both providers failed once each → exhausted → 502/5xx contract response.
    expect(res.status).toBe(502);
    expect(aTimes[0]).toBe(1);
    expect(bTimes[0]).toBe(1);
  });
});
