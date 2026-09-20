/**
 * T15 SSE passthrough, T16 pre-stream failover, T17 stream interruption (no replay),
 * T23 client abort (upstream cancelled, lease released, no health penalty).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  CHAT_BODY,
  activateFetchMock,
  chatRequest,
  deactivateFetchMock,
  mockUpstream,
  routerStub,
  seedProviders,
  sleep,
  sseBody,
  statusMap,
} from "./helpers";
import { pipeUpstreamStream } from "../src/routes/streaming";
import type { ProviderConfigSnapshot } from "../src/types/router";

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

describe("T15: streaming success (SSE passthrough)", () => {
  it("streams upstream SSE bytes verbatim", async () => {
    const seeded = await seedProviders({ a: {} });
    const events = ["one", "two", "three"];
    mockUpstream(seeded.a.baseUrl, {
      body: sseBody(events),
      contentType: "text/event-stream",
    });

    const res = await SELF.fetch(
      chatRequest({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toBe(sseBody(events)); // verbatim bytes, not regenerated

    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.activeRequests).toBe(0);
    expect(snap.get("a")!.lastSuccessAt).not.toBeNull();
  });
});

describe("T16: failover BEFORE the stream starts", () => {
  it("switches to provider B when A rejects pre-stream", async () => {
    const seeded = await seedProviders({
      a: { failureThreshold: 1, cooldownMs: 5_000 },
      b: {},
    });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 503, body: { error: { message: "no capacity" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: sseBody(["hello", "world"]), contentType: "text/event-stream" }, bTimes);

    const res = await SELF.fetch(
      chatRequest({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sseBody(["hello", "world"]));

    expect(aTimes[0]).toBe(1);
    expect(bTimes[0]).toBe(1);
    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.status).toBe("cooldown");
  });
});

describe("T17: stream interrupted AFTER data flowed — never replayed", () => {
  it("terminates the stream and records a stream failure", async () => {
    await seedProviders({ a: {} });
    const stub = routerStub();
    const acquisition = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t17" });
    if (!acquisition.ok) throw new Error("acquire failed");

    // A fake upstream body: chunks arrive over time, then the connection dies.
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        setTimeout(() => controller.enqueue(encoder.encode("data: two\n\n")), 15);
        setTimeout(() => controller.error(new Error("upstream connection reset")), 40);
      },
    });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const abort = new AbortController();
    const req = new Request("http://router.internal/v1/chat/completions", {
      method: "POST",
      body: "x",
      signal: abort.signal,
    });
    let pump: Promise<unknown> = Promise.resolve();
    const readable = pipeUpstreamStream({
      req,
      upstream,
      body: upstream.body!,
      stub,
      providerId: "a",
      leaseId: acquisition.leaseId,
      config: { streamIdleTimeoutMs: 5_000 } as ProviderConfigSnapshot,
      requestId: "t17",
      startedAt: Date.now(),
      waitUntil: (p) => {
        pump = p;
      },
    });

    const res = new Response(readable, { status: 200 });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("one");
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain("two");

    // The stream ends with an error — and provider B is NEVER started.
    await expect(reader.read()).rejects.toThrow();
    await pump;

    const snap = await statusMap(stub);
    expect(snap.get("a")!.consecutiveFailures).toBe(1);
    expect(snap.get("a")!.activeRequests).toBe(0);
  });
});

describe("T23: client abort", () => {
  it("cancels upstream, releases the lease, and does not penalize the provider", async () => {
    await seedProviders({ a: {} });
    const stub = routerStub();
    const acquisition = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t23" });
    if (!acquisition.ok) throw new Error("acquire failed");

    let upstreamCancelled = false;
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        // Never closes: generation would continue forever.
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const abort = new AbortController();
    const req = new Request("http://router.internal/v1/chat/completions", {
      method: "POST",
      body: "x",
      signal: abort.signal,
    });
    let pump: Promise<unknown> = Promise.resolve();
    const readable = pipeUpstreamStream({
      req,
      upstream,
      body: upstream.body!,
      stub,
      providerId: "a",
      leaseId: acquisition.leaseId,
      config: { streamIdleTimeoutMs: 30_000 } as ProviderConfigSnapshot,
      requestId: "t23",
      startedAt: Date.now(),
      waitUntil: (p) => {
        pump = p;
      },
    });

    const res = new Response(readable, { status: 200 });
    const reader = res.body!.getReader();
    await reader.read(); // first chunk reached the "client"

    abort.abort(); // Gruuvix disconnects
    await pump;
    await sleep(20); // let the upstream cancel callback settle

    expect(upstreamCancelled).toBe(true); // upstream generation stopped

    const snap = await statusMap(stub);
    expect(snap.get("a")!.activeRequests).toBe(0); // lease released
    expect(snap.get("a")!.consecutiveFailures).toBe(0); // NOT a provider fault
    expect(snap.get("a")!.status).toBe("healthy");
  });
});
