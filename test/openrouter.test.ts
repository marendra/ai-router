import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env, fetchMock, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import worker, { AiRouterCoordinator } from "../src/index";
import type { Env } from "../src/config/env";
import { DEFAULT_PROVIDER_SEED } from "../src/config/defaults";
import {
  activateFetchMock, CHAT_BODY, chatRequest, COMPLETION_BODY, deactivateFetchMock,
  mockUpstream, routerStub, seedProviders, statusMap,
} from "./helpers";

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

async function enableOpenRouter(): Promise<void> {
  await seedProviders({});
  const result = await routerStub().upsertProvider({ id: "openrouter", enabled: true });
  expect(result.ok).toBe(true);
}

function mockOpenRouter(status: number, response: unknown, streaming = false): string[] {
  const bodies: string[] = [];
  fetchMock.get("https://openrouter.ai")
    .intercept({
      method: "POST", path: "/api/v1/chat/completions",
      // A leaked router key or a missing provider key cannot match this interceptor.
      headers: { authorization: "Bearer test-openrouter-key" },
    })
    .reply(status, (call) => {
      bodies.push(String(call.body));
      return typeof response === "string" ? response : JSON.stringify(response);
    }, { headers: { "Content-Type": streaming ? "text/event-stream" : "application/json" } });
  return bodies;
}

describe("OpenRouter integration", () => {
  it("uses the provider key and price-priority variant of the same GPT-OSS-120B model", async () => {
    await enableOpenRouter();
    const bodies = mockOpenRouter(200, COMPLETION_BODY);
    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COMPLETION_BODY);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      model: "openai/gpt-oss-120b:floor", messages: CHAT_BODY.messages, reasoning_effort: "low",
    });
    expect((await statusMap()).get("openrouter")).toMatchObject({ activeRequests: 0, status: "healthy", maxConcurrentRequests: 5 });
  });

  it("forwards SSE verbatim and requests usage without buffering the completion", async () => {
    await enableOpenRouter();
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n' +
      "data: [DONE]\n\n";
    const bodies = mockOpenRouter(200, sse, true);
    const res = await SELF.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await res.text()).toBe(sse);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      model: "openai/gpt-oss-120b:floor", stream: true, stream_options: { include_usage: true },
    });
    expect((await statusMap()).get("openrouter")!.activeRequests).toBe(0);
  });

  it("fails over and cools down OpenRouter when account credits or the key budget run out", async () => {
    const seeded = await seedProviders({ zbackup: {} });
    await routerStub().upsertProvider({ id: "openrouter", enabled: true });
    const bodies = mockOpenRouter(402, { error: { message: "Insufficient credits" } });
    const backupCalls: number[] = [];
    mockUpstream(seeded.zbackup!.baseUrl, { body: COMPLETION_BODY }, backupCalls);
    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(200);
    await res.text();
    expect(bodies).toHaveLength(1);
    expect(backupCalls[0]).toBe(1);
    expect((await statusMap()).get("openrouter")).toMatchObject({
      activeRequests: 0, status: "cooldown", lastFailureStatus: 402,
    });
  });

  it("fails over safely when the OpenRouter secret has not been configured", async () => {
    const seeded = await seedProviders({ zbackup: {} });
    await routerStub().upsertProvider({ id: "openrouter", enabled: true });
    const bodies = mockOpenRouter(200, COMPLETION_BODY);
    mockUpstream(seeded.zbackup!.baseUrl, { body: COMPLETION_BODY });
    const ctx = createExecutionContext();
    const res = await worker.fetch(chatRequest(CHAT_BODY), {
      ...(env as Env), OPENROUTER_API_KEY: undefined,
    }, ctx);
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(bodies).toHaveLength(0);
    expect((await statusMap()).get("openrouter")).toMatchObject({ activeRequests: 0, status: "cooldown" });
  });
});

describe("OpenRouter registry upgrade", () => {
  it("adds the slot to a v13 database without resetting existing config, health, leases or cursor", async () => {
    await seedProviders({ a: {}, deepinfra: { enabled: false, modelId: "admin-model", maxConcurrentRequests: 7 } });
    const stub = routerStub();
    const lease = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "migration-active" });
    expect(lease.ok).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM providers WHERE id = 'openrouter'");
      sql.exec("DELETE FROM provider_state WHERE provider_id = 'openrouter'");
      sql.exec("UPDATE router_state SET value = '13' WHERE key = 'seed_version'");
      sql.exec("UPDATE provider_state SET status = 'cooldown', consecutive_failures = 3, cooldown_until = ? WHERE provider_id = 'deepinfra'", Date.now() + 60_000);
      const configs = sql.exec("SELECT * FROM providers ORDER BY id").toArray();
      const health = sql.exec("SELECT * FROM provider_state ORDER BY provider_id").toArray();
      const leases = sql.exec("SELECT * FROM leases ORDER BY lease_id").toArray();
      const cursor = sql.exec("SELECT value FROM router_state WHERE key = 'round_robin_cursor'").toArray();
      const rebuilt = new AiRouterCoordinator(state, {});
      expect(sql.exec("SELECT * FROM providers WHERE id != 'openrouter' ORDER BY id").toArray()).toEqual(configs);
      expect(sql.exec("SELECT * FROM provider_state WHERE provider_id != 'openrouter' ORDER BY provider_id").toArray()).toEqual(health);
      expect(sql.exec("SELECT * FROM leases ORDER BY lease_id").toArray()).toEqual(leases);
      expect(sql.exec("SELECT value FROM router_state WHERE key = 'round_robin_cursor'").toArray()).toEqual(cursor);
      expect(sql.exec("SELECT value FROM router_state WHERE key = 'seed_version'").toArray()).toEqual([{ value: "15" }]);
      expect(sql.exec("SELECT model_id, api_key_env FROM providers WHERE id = 'openrouter'").toArray()).toEqual([
        { model_id: "openai/gpt-oss-120b:floor", api_key_env: "OPENROUTER_API_KEY" },
      ]);
      await rebuilt.deleteProvider("openrouter");
      new AiRouterCoordinator(state, {});
      expect(sql.exec("SELECT id FROM providers WHERE id = 'openrouter'").toArray()).toEqual([]);
    });
  });

  it("preserves an existing admin-created OpenRouter slot during the v13 upgrade", async () => {
    await seedProviders({ openrouter: { enabled: false, modelId: "admin-choice", maxConcurrentRequests: 2 } });
    await runInDurableObject(routerStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE router_state SET value = '13' WHERE key = 'seed_version'");
      const before = state.storage.sql.exec("SELECT * FROM providers WHERE id = 'openrouter'").toArray();
      new AiRouterCoordinator(state, {});
      expect(state.storage.sql.exec("SELECT * FROM providers WHERE id = 'openrouter'").toArray()).toEqual(before);
    });
  });
});

describe("Crusoe retirement", () => {
  it("does not seed either Crusoe account on a fresh database", () => {
    expect(DEFAULT_PROVIDER_SEED.some((p) => p.id === "crusoe" || p.id === "crusoe2")).toBe(false);
  });

  it("removes idle Crusoe slots from v14 while preserving other config, health, leases and round-robin position", async () => {
    await seedProviders({
      crusoe: {}, crusoe2: {}, deepinfra: {},
      openrouter: { modelId: "admin-choice", maxConcurrentRequests: 3 },
    });
    const stub = routerStub();
    const failed = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "retirement-failure", excludeProviderIds: ["crusoe", "crusoe2", "openrouter"] });
    if (!failed.ok) throw new Error("expected deepinfra lease");
    await stub.reportFailure({ leaseId: failed.leaseId, providerId: "deepinfra", status: 402, failureClass: "credit_error" });
    const active = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "retirement-active", excludeProviderIds: ["crusoe", "crusoe2"] });
    if (!active.ok) throw new Error("expected OpenRouter lease");
    expect(active.providerId).toBe("openrouter");
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE router_state SET value = '14' WHERE key = 'seed_version'");
      const configs = sql.exec("SELECT * FROM providers WHERE id NOT IN ('crusoe', 'crusoe2') ORDER BY id").toArray();
      const health = sql.exec("SELECT * FROM provider_state WHERE provider_id NOT IN ('crusoe', 'crusoe2') ORDER BY provider_id").toArray();
      const leases = sql.exec("SELECT * FROM leases ORDER BY lease_id").toArray();
      const rebuilt = new AiRouterCoordinator(state, {});
      expect(sql.exec("SELECT * FROM providers ORDER BY id").toArray()).toEqual(configs);
      expect(sql.exec("SELECT * FROM provider_state ORDER BY provider_id").toArray()).toEqual(health);
      expect(sql.exec("SELECT * FROM leases ORDER BY lease_id").toArray()).toEqual(leases);
      const ids = (await rebuilt.listProviders()).providers.map((p) => p.id);
      expect(sql.exec("SELECT value FROM router_state WHERE key = 'round_robin_cursor'").toArray()).toEqual([{ value: String(ids.indexOf("openrouter")) }]);
      expect((await rebuilt.getReadiness()).providers.some((p) => p.id.startsWith("crusoe"))).toBe(false);
      new AiRouterCoordinator(state, {});
      expect(sql.exec("SELECT id FROM providers WHERE id IN ('crusoe', 'crusoe2')").toArray()).toEqual([]);
    });
  });

  it("drains an active Crusoe lease without granting new ones, then deletes the slot", async () => {
    await seedProviders({ crusoe: { maxConcurrentRequests: 1 }, crusoe2: {}, zbackup: {} });
    const stub = routerStub();
    const lease = await stub.acquireProvider({ model: "gpt-oss-120b", requestId: "crusoe-inflight" });
    if (!lease.ok) throw new Error("expected Crusoe lease");
    expect(lease.providerId).toBe("crusoe");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE router_state SET value = '14' WHERE key = 'seed_version'");
      const rebuilt = new AiRouterCoordinator(state, {});
      expect((await rebuilt.listProviders()).providers.find((p) => p.id === "crusoe")).toMatchObject({ enabled: false, pendingDeletion: true, activeRequests: 1 });
      expect((await rebuilt.getReadiness()).providers.some((p) => p.id.startsWith("crusoe"))).toBe(false);
      const next = await rebuilt.acquireProvider({ model: "gpt-oss-120b", requestId: "after-retirement" });
      expect(next.ok && next.providerId).toBe("zbackup");
      expect(await rebuilt.reportSuccess({ leaseId: lease.leaseId, providerId: "crusoe" })).toEqual({ released: true });
      expect((await rebuilt.listProviders()).providers.some((p) => p.id.startsWith("crusoe"))).toBe(false);
    });
  });
});
