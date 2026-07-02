// CF Workers production entry point.
//
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, and fetch invocations use a per-request pg.Pool so a single
//    request's query fan-out runs in parallel instead of serializing.
// 3. Intercepts console.error to capture real error details for `wrangler tail`.

import * as Sentry from "@sentry/cloudflare";
import { SENTRY_DSN } from "./lib/sentry-dsn";
import { scrubSentryEvent } from "./lib/sentry-scrub";
import {
  type BackgroundQueueBatch,
  processBackgroundQueueMessage,
} from "./server/background-queue";
import { setCfEnv } from "./server/cf-env";
import { withRequestDb, withRequestDbClient } from "./server/db";
import { withTrace } from "./server/tracing";

// Cache the handler module promise so the dynamic import only runs once (on
// first request). We keep it lazy (not a top-level static import) so that
// module-level errors are caught in the fetch() try/catch rather than becoming
// silent 500s.
let handlerPromise: Promise<
  typeof import("@tanstack/react-start/server-entry")
>;
const getHandler = () => {
  handlerPromise ??= import("@tanstack/react-start/server-entry");
  return handlerPromise;
};

let lastInterceptedError: {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
} | null = null;

const _origError = console.error;
console.error = (...args: unknown[]) => {
  for (const arg of args) {
    if (arg instanceof Error) {
      lastInterceptedError = {
        name: arg.constructor.name,
        message: arg.message,
        stack: arg.stack,
        cause:
          arg.cause instanceof Error
            ? {
                name: arg.cause.constructor.name,
                message: arg.cause.message,
                stack: arg.cause.stack,
              }
            : arg.cause
              ? String(arg.cause)
              : undefined,
      };
    }
  }
  _origError(...args);
};

const handler = {
  async fetch(request: Request, env: Env) {
    // Bridge CF secrets → process.env for libraries that read from it
    // (better-auth reads BETTER_AUTH_SECRET from process.env at init time)
    process.env.BETTER_AUTH_SECRET ??= env.BETTER_AUTH_SECRET;
    process.env.ALLOW_SIGNUP ??= env.ALLOW_SIGNUP;

    // Expose service bindings to server code (clients pick binding fetch
    // over public URLs when present).
    setCfEnv(env);

    lastInterceptedError = null;

    // Entry span at the very top of our handler body. The CF platform's auto
    // root span covers the whole invocation incl. queue/dispatch BEFORE our code
    // runs; this child measures only time inside fetch(). So when a trace shows
    // a multi-second root with a sub-second tRPC child, the gap localizes here:
    //  - cf.fetch ≈ root  → the time is in our code; the children below say where
    //  - cf.fetch ≪ root  → it's platform queue/dispatch (cold isolate, request
    //                       waiting for a worker) or response-body flush — not us
    // cf.importHandler isolates the first-request dynamic import of the (large)
    // server bundle; cf.handler is the TanStack handler up to the Response being
    // ready (the streamed body finishes after, outside the span).
    const url = new URL(request.url);
    try {
      return await withTrace(
        "cf.fetch",
        (span) =>
          withRequestDb(env.HYPERDRIVE.connectionString, async () => {
            const { default: handler } = await withTrace(
              "cf.importHandler",
              () => getHandler(),
            );
            const response = await withTrace("cf.handler", async () =>
              handler.fetch(request),
            );
            span.setAttribute("http.response.status_code", response.status);

            // If Nitro returned a 500 and we intercepted a real error, log the
            // details so they appear in `wrangler tail` (Nitro's response body
            // is useless) and report it to Sentry — the handler swallows it into
            // a 500 body, so withSentry's auto-capture (thrown-error only) never
            // sees it.
            if (response.status >= 500 && lastInterceptedError) {
              console.error(
                "[cf-server] Unhandled error:",
                JSON.stringify(lastInterceptedError, null, 2),
              );
              const reconstructed = new Error(lastInterceptedError.message);
              reconstructed.name = lastInterceptedError.name;
              reconstructed.stack = lastInterceptedError.stack;
              reconstructed.cause = lastInterceptedError.cause;
              Sentry.captureException(reconstructed);
            }

            return response;
          }),
        { "http.request.method": request.method, "url.path": url.pathname },
      );
    } catch (error) {
      // Report to Sentry before swallowing: we return a generic 500 rather than
      // rethrowing, so withSentry's auto-capture would otherwise miss this.
      Sentry.captureException(error);
      // Log full detail server-side (visible in `wrangler tail`) but never
      // return the stack/message to the client — avoids stack-trace exposure.
      const detail =
        error instanceof Error
          ? `${error.constructor.name}: ${error.message}\n${error.stack}`
          : String(error);
      console.error("[cf-server]", detail);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  // Background queue consumer. Each message is a small persisted-job wakeup:
  // the payload lives in Postgres, so retries are inspectable and queue messages
  // stay bounded. Per-message ack/retry so one bad job doesn't replay the rest.
  async queue(batch: BackgroundQueueBatch, env: Env) {
    setCfEnv(env);
    // Serial queue work does not need a local pg.Pool. Use one Worker-side
    // client for the whole invocation; Hyperdrive still owns the origin DB pool.
    await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
      const { db } = await import("./server/db");
      for (const message of batch.messages) {
        // Per-message clock: a batch is processed serially in this one
        // invocation, so capture t0 at each message's start (NOT at batch
        // arrival) or `duration_ms` would accumulate across the batch.
        const t0 = performance.now();
        try {
          await processBackgroundQueueMessage(db, message);
          console.log(
            `[background-queue] message handled batch=${message.body.batchId} job=${message.body.jobId} kind=${message.body.kind} duration_ms=${Math.round(performance.now() - t0)}`,
          );
        } catch (error) {
          console.error(
            `[background-queue] message failed batch=${message.body.batchId} job=${message.body.jobId} kind=${message.body.kind} duration_ms=${Math.round(performance.now() - t0)}`,
            error,
          );
          Sentry.captureException(error);
          message.retry();
        }
      }
    });
  },
};

export default Sentry.withSentry(
  () => ({
    dsn: SENTRY_DSN,
    sendDefaultPii: true,
    // `sendDefaultPii` attaches the full request URL (incl. query string) to
    // events. Defensively redact any credential-bearing query param (e.g. a
    // stale MCP `?key=`) before the event leaves the process.
    beforeSend: scrubSentryEvent,
    // Mirror the client's prod 10% trace sampling (router.tsx). Head-based
    // sampling decisions propagate client→server via the `sentry-trace` header,
    // so matching the rate keeps front-to-back traces connected without the
    // per-request overhead of full tracing — the same cost/signal call the
    // client already made for this single-user app. Errors are captured
    // regardless of the trace sample rate.
    tracesSampleRate: 0.1,
  }),
  handler,
);
