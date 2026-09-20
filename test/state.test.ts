/**
 * T2 state survival (SQLite persistence across DO lifecycle), T5 lease expiry,
 * T6 idempotent lease release, T24 concurrent load with metrics.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, runInDurableObject } from "cloudflare:test";
import {
  CHAT_BODY,
  COMPLETION_BODY,
  activateFetchMock,
  chatRequest,
  deactivateFetchMock,
  mockUpstream,
  percentile,
  routerStub,
  seedProviders,
  sleep,
  statusMap,
  acquire,
} from "./helpers";
import type { AcquireProviderResult } from "../src/types/router";

function providerId(r: AcquireProviderResult): string {
  if (!r.ok) throw new Error(`expected acquisition, got ${r.reason}`);
  return r.providerId;
}

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

describe("T2: routing state survives DO lifecycle", () => {
  it("persists the round-robin cursor in SQLite, not memory", async () => {
    await seedProviders({ a: {}, b: {} });
    const stub = routerStub();

    expect(providerId(await acquire(stub))).toBe("a");
    expect(providerId(await acquire(stub))).toBe("b");

    // Read the persisted cursor directly from DO storage. The index space is the full
    // id-sorted provider list (including disabled default seeds).
    const all = await stub.listProviders();
    const sortedIds = all.providers.map((p) => p.id).sort();
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT value FROM router_state WHERE key = 'round_robin_cursor'")
        .toArray() as { value: string }[];
      expect(rows.length).toBe(1);
      expect(Number(rows[0]!.value)).toBe(sortedIds.indexOf("b"));
    });

    // A later RPC (potentially a recreated instance) continues from persisted state.
    expect(providerId(await acquire(stub))).toBe("a");
  });
});

describe("T5: lease expiry prevents permanent capacity leaks", () => {
  it("frees a provider after the lease TTL elapses", async () => {
    await seedProviders({ a: { maxConcurrentRequests: 1 } });
    const stub = routerStub();

    const first = await stub.acquireProvider({
      model: "gpt-oss-120b",
      requestId: "t5-1",
      leaseTtlMs: 60,
    });
    expect(first.ok).toBe(true);

    // Still-held lease occupies the only slot.
    const blocked = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t5-2" });
    expect(blocked.ok).toBe(false);

    await sleep(90); // TTL is 60ms

    const after = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t5-3" });
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.providerId).toBe("a");
      // Exactly ONE live lease: the expired lease leaked nothing.
      expect((await statusMap(stub)).get("a")!.activeRequests).toBe(1);
      await stub.reportSuccess({ leaseId: after.leaseId, providerId: "a" });
    }
    expect((await statusMap(stub)).get("a")!.activeRequests).toBe(0); // fully drained
  });
});

describe("T6: idempotent lease release", () => {
  it("never lets activeRequests go negative on double reports", async () => {
    await seedProviders({ a: {} });
    const stub = routerStub();

    const lease = await acquire(stub);
    if (!lease.ok) throw new Error("acquire failed");
    expect((await statusMap(stub)).get("a")!.activeRequests).toBe(1);

    const first = await stub.reportSuccess({ leaseId: lease.leaseId, providerId: "a" });
    const second = await stub.reportSuccess({ leaseId: lease.leaseId, providerId: "a" });
    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
    expect((await statusMap(stub)).get("a")!.activeRequests).toBe(0);

    // Reporting failure on the already-released lease is also a safe no-op.
    const failure = await stub.reportFailure({
      leaseId: lease.leaseId,
      providerId: "a",
      status: 500,
      failureClass: "provider_overloaded",
    });
    expect(failure.released).toBe(false);
    expect((await statusMap(stub)).get("a")!.consecutiveFailures).toBe(0);
  });
});

describe("T24: many concurrent requests", () => {
  it("handles 100 concurrent requests with clean lease accounting", async () => {
    const seeded = await seedProviders({
      a: { maxConcurrentRequests: 40 },
      b: { maxConcurrentRequests: 40 },
      c: { maxConcurrentRequests: 40 },
    });
    const times: Record<string, number[]> = {
      a: [],
      b: [],
      c: [],
    };
    mockUpstream(seeded.a.baseUrl, { body: COMPLETION_BODY }, times.a);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, times.b);
    mockUpstream(seeded.c.baseUrl, { body: COMPLETION_BODY }, times.c);

    const startedAt = Date.now();
    const latencies: number[] = [];
    const responses = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const t0 = Date.now();
        const res = await SELF.fetch(chatRequest(CHAT_BODY));
        await res.arrayBuffer();
        latencies.push(Date.now() - t0);
        return res.status;
      }),
    );

    expect(responses.every((s) => s === 200)).toBe(true);

    // Metrics: simple percentiles over measured client-observed latencies.
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    expect(p50).toBeGreaterThanOrEqual(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);

    // Reasonable distribution across all three providers.
    const total = (times.a[0] ?? 0) + (times.b[0] ?? 0) + (times.c[0] ?? 0);
    expect(total).toBe(100);
    expect(times.a[0]).toBeGreaterThan(5);
    expect(times.b[0]).toBeGreaterThan(5);
    expect(times.c[0]).toBeGreaterThan(5);

    // All leases released, nothing corrupted.
    const snap = await statusMap(routerStub());
    for (const id of ["a", "b", "c"]) {
      const view = snap.get(id)!;
      expect(view.activeRequests).toBe(0);
      expect(view.consecutiveFailures).toBe(0);
      expect(view.status).toBe("healthy");
    }
  }, 60_000);
});
