/**
 * Dashboard session cookies. The login secret is the router key itself, but the cookie
 * NEVER contains it: the value is "<expiryEpochMs>.<HMAC-SHA256(key, "gx-dash:<exp>")>"
 * — tamper-proof (key-signed), self-expiring, and revocable by rotating the key.
 */
import { timingSafeEqual } from "../utils/security";

export const DASHBOARD_COOKIE = "gx_dash";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600; // "save login" = 1 month
const SHORT_SESSION_MS = 12 * 3600_000; // no "save login": browser-session cookie, 12h hard cap

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function createSessionValue(
  secret: string,
  saveLogin: boolean,
): Promise<{ value: string; maxAge: number | null }> {
  const ttlMs = saveLogin ? SESSION_MAX_AGE_S * 1000 : SHORT_SESSION_MS;
  const exp = Date.now() + ttlMs;
  const sig = await sign(secret, `gx-dash:${exp}`);
  return { value: `${exp}.${sig}`, maxAge: saveLogin ? SESSION_MAX_AGE_S : null };
}

/** Validate a cookie value against the current secret. Expired or forged → false. */
export async function verifySessionValue(secret: string, value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d{13,16}$/.test(expStr)) return false;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const expected = await sign(secret, `gx-dash:${exp}`);
  return timingSafeEqual(expected, sig);
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** True when the request carries a valid dashboard session (or the key itself). */
export async function hasDashboardSession(req: Request, secret: string): Promise<boolean> {
  return verifySessionValue(secret, readCookie(req, DASHBOARD_COOKIE));
}

export function sessionCookieHeader(value: string, maxAge: number | null): string {
  let cookie = `${DASHBOARD_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  if (maxAge !== null) cookie += `; Max-Age=${maxAge}`;
  return cookie;
}

export function clearSessionCookieHeader(): string {
  return `${DASHBOARD_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
