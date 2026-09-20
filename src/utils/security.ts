/** Constant-time-ish string comparison for bearer secrets. */

export function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Extract "Bearer <token>" from an Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}
