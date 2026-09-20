import { bearerToken, timingSafeEqual } from "../utils/security";
import { unauthorized } from "../utils/errors";

/** Gruuvix -> Router data-plane authentication. */
export function requireRouterKey(req: Request, routerKey: string | undefined): Response | null {
  if (!routerKey) {
    // Router not configured: fail closed rather than serving unauthenticated traffic.
    return unauthorized("Router API key is not configured.");
  }
  const token = bearerToken(req);
  if (!token || !timingSafeEqual(token, routerKey)) return unauthorized();
  return null;
}
