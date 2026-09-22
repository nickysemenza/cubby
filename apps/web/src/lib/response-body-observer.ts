type ResponseBodyOutcome = "complete" | "cancelled" | "error" | "empty";

export type ResponseBodyObservation = {
  outcome: ResponseBodyOutcome;
  durationMs: number;
};

/**
 * Observe a response body's actual lifetime without draining or buffering it.
 *
 * The observer is deliberately synchronous and isolated from delivery: a
 * telemetry failure must never turn a healthy response stream into an error.
 * This is the stream Adapter needed for a detached/manual span, but the current
 * Cloudflare tracing Interface only auto-ends callback-scoped spans.
 */
export const observeResponseBody = (
  response: Response,
  observe: (observation: ResponseBodyObservation) => void,
  now: () => number = () => performance.now(),
): Response => {
  const startedAt = now();
  let settled = false;
  const settle = (outcome: ResponseBodyOutcome) => {
    if (settled) return;
    settled = true;
    try {
      observe({ outcome, durationMs: Math.max(0, now() - startedAt) });
    } catch {
      // SILENT: observability is fail-open — a telemetry callback failure must
      // never turn a healthy response stream into an error; body delivery
      // owns this boundary, not this observer.
    }
  };

  if (!response.body) {
    settle("empty");
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle("complete");
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        settle("error");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle("cancelled");
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
