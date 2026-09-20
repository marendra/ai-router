/** T18 router auth, T19 admin auth, plus admin CRUD flow and secret-name validation. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  ADMIN_KEY,
  CHAT_BODY,
  COMPLETION_BODY,
  ROUTER_KEY,
  activateFetchMock,
  chatRequest,
  deactivateFetchMock,
  mockUpstream,
  seedProviders,
} from "./helpers";

describe("T18 router authentication", () => {
  beforeEach(activateFetchMock);
  afterEach(deactivateFetchMock);

  it("rejects missing/invalid router keys with 401 and never calls upstream", async () => {
    const seeded = await seedProviders({ a: {} });
    const times: number[] = [];
    mockUpstream(seeded.a.baseUrl, { body: COMPLETION_BODY }, times);

    const noKey = new Request("http://router.internal/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    });
    const noKeyRes = await SELF.fetch(noKey);
    expect(noKeyRes.status).toBe(401);

    const wrongKey = await SELF.fetch(chatRequest(CHAT_BODY, "wrong-key"));
    expect(wrongKey.status).toBe(401);

    // Models endpoint is part of the authenticated data plane too.
    const modelsNoKey = await SELF.fetch("http://router.internal/v1/models");
    expect(modelsNoKey.status).toBe(401);

    expect(times[0]).toBeUndefined(); // no upstream call ever happened
  });

  it("serves authenticated requests", async () => {
    const seeded = await seedProviders({ a: {} });
    const times: number[] = [];
    mockUpstream(seeded.a.baseUrl, { body: COMPLETION_BODY }, times);
    const res = await SELF.fetch(chatRequest(CHAT_BODY));
    expect(res.status).toBe(200);
    expect(times[0]).toBe(1);
  });
});

describe("T19 admin authentication + provider management", () => {
  beforeEach(activateFetchMock);
  afterEach(deactivateFetchMock);

  it("rejects missing/invalid admin keys on /internal/*", async () => {
    const noKey = await SELF.fetch("http://router.internal/internal/providers");
    expect(noKey.status).toBe(401);

    const wrong = await SELF.fetch("http://router.internal/internal/providers", {
      headers: { Authorization: `Bearer not-admin` },
    });
    expect(wrong.status).toBe(401);
  });

  it("supports status + create + patch + delete with a valid admin key", async () => {
    const listRes = await SELF.fetch("http://router.internal/internal/providers", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { providers: { id: string }[] };
    expect(Array.isArray(listBody.providers)).toBe(true);

    // Secret VALUES can never be stored: only env-var names are accepted.
    const secretAttempt = await SELF.fetch("http://router.internal/internal/providers", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "evil",
        baseUrl: "http://evil.test/v1",
        modelId: "m",
        apiKeyEnv: "sk-live-actual-secret",
      }),
    });
    expect(secretAttempt.status).toBe(400);

    const create = await SELF.fetch("http://router.internal/internal/providers", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "prov-x",
        baseUrl: "http://prov-x.test/v1",
        modelId: "fake-model-x",
      }),
    });
    expect(create.status).toBe(200);
    const createBody = (await create.json()) as { ok: boolean; provider: { id: string } };
    expect(createBody.ok).toBe(true);
    expect(createBody.provider.id).toBe("prov-x");

    const getOne = await SELF.fetch("http://router.internal/internal/providers/prov-x", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(getOne.status).toBe(200);

    const patch = await SELF.fetch("http://router.internal/internal/providers/prov-x", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { provider: { enabled: boolean } };
    expect(patchBody.provider.enabled).toBe(false);

    const del = await SELF.fetch("http://router.internal/internal/providers/prov-x", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deleted: boolean };
    expect(delBody.deleted).toBe(true);
  });
});
