/** Request ids: honor a client-supplied x-request-id when sane, else generate. */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function resolveRequestId(req: Request): string {
  const incoming = req.headers.get("x-request-id");
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return crypto.randomUUID();
}
