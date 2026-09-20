/**
 * T13 cooldown skipping + recovery eligibility, T14 half-open single-probe discipline.
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
  sleep,
  statusMap,
} from "./helpers";

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

describe("T13: cooldown", () => {
  it("skips a cooling provider and lets it return via a half-open probe", async () => {
    const seeded = await seedProviders({
      a: { failureThreshold: 1, cooldownMs: 400 },
      b: {},
    });
    const aTimes: number[] = [];
    const bTimes: number[] = [];
    mockUpstream(seeded.a.baseUrl, { status: 500, body: { error: { message: "boom" } } }, aTimes);
    mockUpstream(seeded.b.baseUrl, { body: COMPLETION_BODY }, bTimes);

    // Request 1: a fails once (threshold 1) → cooldown; b serves.
    const res1 = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res1.status).toBe(200);
    expect(aTimes[0]).toBe(1);

    let snap = await statusMap(routerStub());
    expect(snap.get("a")!.status).toBe("cooldown");

    // Request 2: a is skipped entirely.
    const res2 = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res2.status).toBe(200);
    expect(aTimes[0]).toBe(1);
    expect(bTimes[0]).toBe(2);

    // Cooldown elapses → a derives to half_open (probe-eligible again).
    await sleep(450);
    snap = await statusMap(routerStub());
    expect(snap.get("a")!.status).toBe("half_open");
  }, 15_000);
});

describe("T14: half-open allows exactly one probe", () => {
  it("blocks concurrent probes and routes the outcome back to healthy/cooldown", async () => {
    await seedProviders({ a: { failureThreshold: 1, cooldownMs: 300 } });
    const stub = routerStub();

    // Trip the breaker with a direct failure report.
    const lease = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t14-0" });
    if (!lease.ok) throw new Error("acquire failed");
    await stub.reportFailure({
      leaseId: lease.leaseId,
      providerId: "a",
      status: 500,
      failureClass: "provider_overloaded",
    });
    let snap = await statusMap(stub);
    expect(snap.get("a")!.status).toBe("cooldown");

    await sleep(320); // → half_open (derived)

    // First acquire after cooldown = the ONE probe.
    const probe = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t14-1" });
    expect(probe.ok).toBe(true);

    // A second concurrent acquire must NOT be granted another probe.
    const second = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t14-2" });
    expect(second.ok).toBe(false);

    snap = await statusMap(stub);
    expect(snap.get("a")!.status).toBe("half_open");
    expect(snap.get("a")!.halfOpenProbeActive).toBe(true);

    // Probe fails → back to cooldown.
    await stub.reportFailure({
      leaseId: (probe as { leaseId: string }).leaseId,
      providerId: "a",
      status: 503,
      failureClass: "provider_overloaded",
    });
    snap = await statusMap(stub);
    expect(snap.get("a")!.status).toBe("cooldown");

    // Next window: a successful probe restores health.
    await sleep(320);
    const probe2 = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "t14-3" });
    expect(probe2.ok).toBe(true);
    await stub.reportSuccess({
      leaseId: (probe2 as { leaseId: string }).leaseId,
      providerId: "a",
    });
    snap = await statusMap(stub);
    expect(snap.get("a")!.status).toBe("healthy");
  }, 15_000);
});
