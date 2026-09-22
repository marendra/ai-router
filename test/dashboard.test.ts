/** Dashboard: login flow, cookie session (incl. tamper rejection), cookie-authed /v1/usage. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  ROUTER_KEY,
  activateFetchMock,
  deactivateFetchMock,
} from "./helpers";

const BASE = "http://router.internal";

function loginRequest(token: string, save: boolean): Request {
  return new Request(`${BASE}/dashboard/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, ...(save ? { save: "on" } : {}) }).toString(),
    redirect: "manual", // fetch() follows redirects by default — we want the 303 itself
  });
}

function sessionCookieOf(res: Response): string | undefined {
  const set = res.headers.get("Set-Cookie") ?? "";
  const pair = set.split(";")[0];
  return pair && pair.includes("=") ? pair : undefined;
}

beforeEach(activateFetchMock);
afterEach(deactivateFetchMock);

describe("dashboard login", () => {
  it("serves the login page when unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="token"');
    expect(html).toContain("30 days");
  });

  it("rejects a wrong token with the error redirect and NO session", async () => {
    const res = await SELF.fetch(loginRequest("wrong-key", true));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/dashboard?e=1");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("sets a 30-day HttpOnly cookie on valid login with save", async () => {
    const res = await SELF.fetch(loginRequest(ROUTER_KEY, true));
    expect(res.status).toBe(303);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("gx_dash=");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain(ROUTER_KEY); // raw key never lands in the cookie
  });

  it("sets a session cookie (no Max-Age) without save", async () => {
    const res = await SELF.fetch(loginRequest(ROUTER_KEY, false));
    expect(res.status).toBe(303);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("gx_dash=");
    expect(cookie).not.toContain("Max-Age=2592000");
  });
});

describe("dashboard session usage", () => {
  it("renders the dashboard with a valid cookie", async () => {
    const login = await SELF.fetch(loginRequest(ROUTER_KEY, true));
    const cookie = sessionCookieOf(login)!;
    const res = await SELF.fetch(`${BASE}/dashboard`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Provider Token Usage");
    expect(html).toContain("id=\"charts\"");
    expect(html).toContain("id=\"databox\"");
  });

  it("lets the cookie authorize /v1/usage without a bearer token", async () => {
    const login = await SELF.fetch(loginRequest(ROUTER_KEY, true));
    const cookie = sessionCookieOf(login)!;

    const none = await SELF.fetch(`${BASE}/v1/usage`);
    expect(none.status).toBe(401);

    const withCookie = await SELF.fetch(`${BASE}/v1/usage?from=2026-09-01`, {
      headers: { Cookie: cookie },
    });
    // 503 = authenticated but ledger binding absent in tests; 401 would mean auth failed.
    expect(withCookie.status).toBe(503);
  });

  it("rejects forged or malformed session cookies", async () => {
    const withGarbage = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Cookie: "gx_dash=1750000000000.deadbeef" },
    });
    expect(withGarbage.status).toBe(401);
  });

  it("logout clears the session cookie in the browser", async () => {
    const login = await SELF.fetch(loginRequest(ROUTER_KEY, true));
    const cookie = sessionCookieOf(login)!;
    const out = await SELF.fetch(`${BASE}/dashboard/logout`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(out.status).toBe(303);
    const clear = out.headers.get("Set-Cookie") ?? "";
    expect(clear).toContain("Max-Age=0");

    // Stateless design: logout deletes the cookie client-side (it cannot be
    // server-revoked; rotating the router key revokes all sessions). Simulate the
    // browser obeying the clearing header:
    const after = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Cookie: "gx_dash=" },
    });
    expect(after.status).toBe(401);
  });
});
