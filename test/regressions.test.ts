/**
 * Regression tests for the 2026-09-20 review findings:
 *  R1 probe flag must never wedge a provider half-open forever
 *  R4 stalled streams are failures, not clean successes
 *  R6 non-JSON 2xx bodies pass through (no router 500 after success)
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
  sleep,
  statusMap,
} from "./helpers";
import { pipeUpstreamStream } from "../src/routes/streaming";
import type { StreamOutcome } from "../src/routes/streaming";
import type { ProviderConfigSnapshot } from "../src/types/router";

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

async function tripBreaker(
  stub: ReturnType<typeof routerStub>,
  providerId: string,
): Promise<void> {
  const lease = await acquire(stub, "trip");
  if (!lease.ok) throw new Error("acquire failed");
  await stub.reportFailure({
    leaseId: lease.leaseId,
    providerId,
    status: 500,
    failureClass: "provider_overloaded",
  });
}

describe("R1: half-open probe flag can never wedge a provider", () => {
  it("frees the probe when its lease EXPIRES unreported", async () => {
    await seedProviders({ a: { failureThreshold: 1, cooldownMs: 120 } });
    const stub = routerStub();
    await tripBreaker(stub, "a");
    await sleep(150); // cooldown elapses → half_open

    // Probe granted with a short TTL, then never reported (worker crashed).
    const probe = await stub.acquireProvider({
      model: "gpt-oss-120b",
      requestId: "r1a",
      leaseTtlMs: 60,
    });
    expect(probe.ok).toBe(true);
    expect((await statusMap(stub)).get("a")!.halfOpenProbeActive).toBe(true);

    await sleep(90); // probe lease expires

    // Housekeeping must clear the stale flag: provider is acquirable again.
    const next = await acquire(stub, "r1b");
    expect(next.ok).toBe(true);
  });

  it("frees the probe on a NON-PENALIZING outcome (client_error)", async () => {
    await seedProviders({ a: { failureThreshold: 1, cooldownMs: 120 } });
    const stub = routerStub();
    await tripBreaker(stub, "a");
    await sleep(150); // → half_open

    const probe = await acquire(stub, "r1c");
    if (!probe.ok) throw new Error("probe not granted");

    // A 400 on the probe: releases the lease without penalty — and MUST release
    // the probe slot too.
    await stub.reportFailure({
      leaseId: probe.leaseId,
      providerId: "a",
      status: 400,
      failureClass: "client_error",
    });

    const next = await acquire(stub, "r1d");
    expect(next.ok).toBe(true);
    // Non-penalizing outcome: failure count unchanged (still 1 from the original trip;
    // only a success resets it) — but the probe slot is free.
    expect((await statusMap(stub)).get("a")!.consecutiveFailures).toBe(1);
  });
});

describe("R4: stalled stream is a failure, never a clean success", () => {
  it("idle watchdog reports timeout and errors the client stream", async () => {
    await seedProviders({ a: {} });
    const stub = routerStub();
    const acquisition = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "r4" });
    if (!acquisition.ok) throw new Error("acquire failed");

    const encoder = new TextEncoder();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        // then silence forever
      },
    });

    let pump: Promise<unknown> = Promise.resolve();
    const outcomes: StreamOutcome[] = [];
    const readable = pipeUpstreamStream({
      req: new Request("http://x/", { method: "POST", body: "x" }),
      upstream: new Response(stalled, { status: 200 }),
      body: stalled,
      stub,
      providerId: "a",
      leaseId: acquisition.leaseId,
      config: { streamIdleTimeoutMs: 80 } as ProviderConfigSnapshot,
      requestId: "r4",
      startedAt: Date.now(),
      waitUntil: (p) => {
        pump = p;
      },
      onSettled: (o) => outcomes.push(o),
    });

    const reader = readable.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("one");

    // Stall: watchdog cancels the source → client sees an ERROR, not clean EOF.
    await expect(reader.read()).rejects.toThrow();
    await pump;

    const snap = await statusMap(stub);
    expect(snap.get("a")!.consecutiveFailures).toBe(1); // penalized
    expect(snap.get("a")!.activeRequests).toBe(0);
    expect(outcomes[0]!.success).toBe(false);
    expect(outcomes[0]!.failureClass).toBe("timeout");
  });
});

describe("R6: non-JSON 2xx body passes through", () => {
  it("returns the raw body with 200 instead of a router 500", async () => {
    const seeded = await seedProviders({ a: {} });
    mockUpstream(seeded.a.baseUrl, {
      status: 200,
      body: "plain-text-not-json",
      contentType: "text/plain",
    });

    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain-text-not-json");

    // Provider stays healthy: this was a success, just an opaque body.
    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.status).toBe("healthy");
    expect(snap.get("a")!.consecutiveFailures).toBe(0);
  });
});

describe("R3: client abort stops the upstream generation", () => {
  it("cancels the upstream source (no tee branch keeping it alive)", async () => {
    await seedProviders({ a: {} });
    const stub = routerStub();
    const acquisition = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "r3" });
    if (!acquisition.ok) throw new Error("acquire failed");

    let upstreamCancelled = false;
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
      },
      cancel() {
        upstreamCancelled = true; // the real upstream fetch would stop generating here
      },
    });

    const abort = new AbortController();
    const req = new Request("http://x/", { method: "POST", body: "x", signal: abort.signal });
    let pump: Promise<unknown> = Promise.resolve();
    const readable = pipeUpstreamStream({
      req,
      upstream: new Response(source, { status: 200 }),
      body: source,
      stub,
      providerId: "a",
      leaseId: acquisition.leaseId,
      config: { streamIdleTimeoutMs: 30_000 } as ProviderConfigSnapshot,
      requestId: "r3",
      startedAt: Date.now(),
      waitUntil: (p) => {
        pump = p;
      },
    });

    const reader = readable.getReader();
    await reader.read();
    abort.abort();
    await pump;
    await sleep(20);

    expect(upstreamCancelled).toBe(true); // generation stopped, not just the client branch
    const snap = await statusMap(stub);
    expect(snap.get("a")!.activeRequests).toBe(0);
    expect(snap.get("a")!.consecutiveFailures).toBe(0); // no health penalty
  });
});

describe("R2: streaming timeout is time-to-first-response only", () => {
  it("a stream whose body takes longer than timeoutMs still completes", async () => {
    // Upstream answers headers immediately, then streams for ~450ms total. Provider
    // timeoutMs (60ms) must NOT cut the body — only the idle watchdog governs it.
    const seeded = await seedProviders({ a: { timeoutMs: 60, streamIdleTimeoutMs: 5_000 } });
    mockUpstream(seeded.a.baseUrl, {
      body: "data: chunk-by-chunk-slow-generation\n\ndata: [DONE]\n\n",
      contentType: "text/event-stream",
    });

    const res = await SELF.fetch(
      chatRequest({ ...CHAT_BODY, stream: true }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");

    const snap = await statusMap(routerStub());
    expect(snap.get("a")!.status).toBe("healthy");
    expect(snap.get("a")!.consecutiveFailures).toBe(0);
  });
});
