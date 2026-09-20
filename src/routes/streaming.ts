/**
 * SSE passthrough with the streaming failover rules:
 *  - failover only BEFORE any byte has been forwarded (handled in chatCompletions route);
 *  - once streaming, never replay with another provider — terminate and report;
 *  - idle watchdog kills silent streams (tracked explicitly so a stall is NEVER
 *    reported as success), healthy long streams are never timed out;
 *  - success is reported only at clean stream end (activeRequests stays honest);
 *  - client disconnect cancels the upstream fetch (single stream — no tee, so the
 *    generation actually stops) and reports client_abort (no health penalty);
 *  - usage is harvested from the SAME stream and recorded at settlement with the
 *    final outcome and full-stream duration.
 */
import type { FailureClass, ProviderConfigSnapshot, ReportFailureRequest, ReportSuccessRequest } from "../types/router";
import { EMPTY_USAGE, extractUsageFromSseDump, type TokenUsage } from "../usage/usageLedger";

/** Minimal coordinator surface the streamer needs (works with DO RPC stubs in tests). */
export interface StreamCoordinator {
  reportSuccess(request: ReportSuccessRequest): Promise<{ released: boolean }>;
  reportFailure(request: ReportFailureRequest): Promise<{ released: boolean }>;
}

/** Final outcome of a stream, handed to onSettled exactly once. */
export interface StreamOutcome extends TokenUsage {
  success: boolean;
  failureClass: FailureClass;
  latencyMs: number;
}

export interface StreamArgs {
  req: Request;
  upstream: Response;
  /** The upstream body to pipe (the stream itself — never a tee() branch). */
  body: ReadableStream<Uint8Array>;
  stub: StreamCoordinator;
  providerId: string;
  leaseId: string;
  config: ProviderConfigSnapshot;
  requestId: string;
  startedAt: number;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Accumulate (tail-capped) SSE text for usage harvesting. */
  collectUsage?: boolean;
  /** Called once when the stream settles — the usage row's source of truth. */
  onSettled?: (outcome: StreamOutcome) => void;
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
  const { req, stub, providerId, leaseId, config, startedAt } = args;
  const idleMs = config.streamIdleTimeoutMs;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  let reported = false;
  let dump: string | undefined = args.collectUsage ? "" : undefined;

  const reportFinal = async (success: boolean, failureClass: FailureClass): Promise<void> => {
    if (reported) return;
    reported = true;
    const latencyMs = Date.now() - startedAt; // full-stream duration, not time-to-headers
    const usage: TokenUsage =
      success && dump !== undefined ? extractUsageFromSseDump(dump) : EMPTY_USAGE;
    try {
      args.onSettled?.({ success, failureClass, latencyMs, ...usage });
    } catch {
      // the ledger must never break the stream
    }
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
    const decoder = new TextDecoder();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false; // watchdog fired: EOF below is a stall, NOT success

    const armIdleWatchdog = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        void reader.cancel("stream idle timeout").catch(() => {});
      }, idleMs);
    };

    // Cancelling this reader cancels the upstream fetch itself (no tee in between).
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
        if (dump !== undefined) {
          dump += decoder.decode(value, { stream: true });
          if (dump.length > 4_194_304) dump = dump.slice(-1_048_576); // cap memory on runaway streams
        }
        await writer.write(value);
      }
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (timedOut) {
        // Stalled stream: terminate with an error so the client sees truncation,
        // and penalize the provider — a stall is never a success.
        await reportFinal(false, "timeout");
        writer.abort(new Error("stream idle timeout")).catch(() => {});
        return;
      }
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
