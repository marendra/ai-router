/** GET /health — process-level health only. Never pings upstream providers. */
export function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
