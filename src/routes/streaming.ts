/**
 * SSE passthrough with the streaming failover rules:
 *  - failover only BEFORE any byte has been forwarded (handled in chatCompletions route);
 *  - once streaming, never replay with another provider — terminate and report;
 *  - idle watchdog kills silent streams, healthy long streams are never timed out;
 *  - success is reported only at clean stream end (activeRequests stays honest);
 *  - client disconnect cancels upstream and reports client_abort (no health penalty).
 */
import type { FailureClass, ProviderConfigSnapshot, ReportFailureRequest, ReportSuccessRequest } from "../types/router";

/** Minimal coordinator surface the streamer needs (works with DO RPC stubs in tests). */
export interface StreamCoordinator {
  reportSuccess(request: ReportSuccessRequest): Promise<{ released: boolean }>;
  reportFailure(request: ReportFailureRequest): Promise<{ released: boolean }>;
}

export interface StreamArgs {
  req: Request;
  upstream: Response;
  /** The byte stream to pipe (may be a tee() branch when usage harvesting is on). */
  body: ReadableStream<Uint8Array>;
  stub: StreamCoordinator;
  providerId: string;
  leaseId: string;
  config: ProviderConfigSnapshot;
  requestId: string;
  startedAt: number;
  waitUntil: (promise: Promise<unknown>) => void;
}

export function buildStreamResponseHeaders(
  upstream: Response,
  requestId: string,
  extra: Record<string, string>,
): Headers {
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("x-request-id", requestId);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

export function pipeUpstreamStream(args: StreamArgs): ReadableStream {
  const { req, upstream, stub, providerId, leaseId, config, startedAt } = args;
  const idleMs = config.streamIdleTimeoutMs;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  let reported = false;

  const reportFinal = async (success: boolean, failureClass: FailureClass): Promise<void> => {
    if (reported) return;
    reported = true;
    const latencyMs = Date.now() - startedAt;
    try {
      if (success) {
        await stub.reportSuccess({ leaseId, providerId, latencyMs });
      } else {
        await stub.reportFailure({ leaseId, providerId, status: null, failureClass, latencyMs });
      }
    } catch {
      // Never let report RPC failures break the client stream; lease TTL covers us.
    }
  };

  const pump = async (): Promise<void> => {
    const writer = writable.getWriter();
    const reader = args.body.getReader();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const armIdleWatchdog = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void reader.cancel("stream idle timeout").catch(() => {});
      }, idleMs);
    };

    const onClientAbort = (): void => {
      void reader.cancel("client aborted").catch(() => {});
    };
    req.signal?.addEventListener("abort", onClientAbort, { once: true });

    armIdleWatchdog();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleWatchdog();
        await writer.write(value);
      }
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      // A stream that ends because the CLIENT vanished is not a provider success.
      if (req.signal?.aborted === true) {
        await reportFinal(false, "client_abort");
        try {
          await writer.close();
        } catch {
          // client side already gone
        }
      } else {
        await writer.close();
        await reportFinal(true, "unknown");
      }
    } catch {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      const clientAborted = req.signal?.aborted === true;
      await reportFinal(false, clientAborted ? "client_abort" : "stream_interrupted");
      // Best-effort teardown: tolerate a stream that is already broken/closed.
      reader.cancel().catch(() => {});
      writer
        .abort(
          clientAborted ? new Error("client aborted") : new Error("upstream stream interrupted"),
        )
        .catch(() => {});
    } finally {
      req.signal?.removeEventListener("abort", onClientAbort);
    }
  };

  args.waitUntil(pump());
  return readable;
}
