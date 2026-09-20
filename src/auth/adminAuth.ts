import { bearerToken, timingSafeEqual } from "../utils/security";
import { unauthorized } from "../utils/errors";

/** Admin-plane authentication for /internal/*. Separate key from the data plane. */
export function requireAdminKey(req: Request, adminKey: string | undefined): Response | null {
  if (!adminKey) {
    return unauthorized("Admin API key is not configured.");
  }
  const token = bearerToken(req);
  if (!token || !timingSafeEqual(token, adminKey)) return unauthorized();
  return null;
}
