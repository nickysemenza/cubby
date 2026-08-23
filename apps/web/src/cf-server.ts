// CF Workers production entry point.
//
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, and fetch invocations use a per-request pg.Pool so a single
//    request's query fan-out runs in parallel instead of serializing.
// 3. Intercepts console.error to capture real error details for `wrangler tail`.

import { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/cloudflare";
import { withHtmlNoCache } from "./lib/http-cache";
import { SENTRY_DSN } from "./lib/sentry-dsn";
import { scrubSentryEvent } from "./lib/sentry-scrub";
import type { BackgroundQueueBatch } from "./server/background-queue-types";
import { setCfEnv } from "./server/cf-env";
import { withRequestDb, withRequestDbClient } from "./server/db";
import type { TelemetryQueueBatch } from "./server/telemetry-queue-types";
import { withTrace } from "./server/tracing";
import { classifyHttpWorkload } from "./server/workload";

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

interface InterceptedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

// Per-request holder for the console.error-intercepted error, scoped via
// AsyncLocalStorage — mirrors withRequestDb's per-request pool store in
// server/db.ts. Workers reuse one isolate across concurrent in-flight
// requests, so a plain module-level `let` here would let request B's
// console.error reset/overwrite the value across an await before request A
// reads it, dropping A's real error or shipping B's as A's.
const interceptedErrorStore = new AsyncLocalStorage<{
  error: InterceptedError | null;
}>();

const _origError = console.error;
console.error = (...args: unknown[]) => {
  const holder = interceptedErrorStore.getStore();
  if (holder) {
    for (const arg of args) {
      if (arg instanceof Error) {
        holder.error = {
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
  }
  _origError(...args);
};

const handler = {
  async fetch(request: Request, env: Env) {
    // Bridge CF secrets → process.env for libraries that read from it
    // (better-auth reads BETTER_AUTH_SECRET from process.env at init time)
    process.env.BETTER_AUTH_SECRET ??= env.BETTER_AUTH_SECRET;
    process.env.ALLOW_SIGNUP ??= env.ALLOW_SIGNUP;
    process.env.E2E_AUTH_TEST_MODE = env.E2E_AUTH_TEST_MODE;

    // Expose service bindings to server code (clients pick binding fetch
    // over public URLs when present).
    setCfEnv(env);

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
      return await interceptedErrorStore.run({ error: null }, () =>
        withTrace(
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
              const interceptedError = interceptedErrorStore.getStore()?.error;
              if (response.status >= 500 && interceptedError) {
                console.error(
                  "[cf-server] Unhandled error:",
                  JSON.stringify(interceptedError, null, 2),
                );
                const reconstructed = new Error(interceptedError.message);
                reconstructed.name = interceptedError.name;
                reconstructed.stack = interceptedError.stack;
                reconstructed.cause = interceptedError.cause;
                Sentry.captureException(reconstructed);
              }

              return withHtmlNoCache(response);
            }),
          {
            "http.request.method": request.method,
            "url.path": url.pathname,
            "server.address": url.hostname,
            "cubby.workload": classifyHttpWorkload(
              url.pathname,
              request.headers,
            ),
          },
        ),
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
  async queue(batch: BackgroundQueueBatch | TelemetryQueueBatch, env: Env) {
    setCfEnv(env);
    await withTrace(
      "cf.queue",
      async () => {
        // Serial queue work does not need a local pg.Pool. Use one Worker-side
        // client for the whole invocation; Hyperdrive still owns the origin DB pool.
        await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
          if (batch.queue === "cubby-telemetry") {
            const [{ db }, { processTelemetryQueueBatch }] = await Promise.all([
              import("./server/db"),
              import("./server/telemetry-queue"),
            ]);
            await processTelemetryQueueBatch(db, batch);
            return;
          }

          // Imported here, not at module scope: the consumer pulls @tanstack/ai +
          // @cloudflare/tanstack-ai + @anthropic-ai/sdk (~553 KiB, plus a second
          // copy of zod) and only queue deliveries need it. A static import puts
          // all of that on the module-init path of every fetch invocation too.
          const [{ db }, { processBackgroundQueueMessage }] = await Promise.all(
            [import("./server/db"), import("./server/background-queue")],
          );
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
      {
        "cubby.workload": "queue",
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
      },
    );
  },

  async scheduled(_controller: { scheduledTime: number }, env: Env) {
    setCfEnv(env);
    await withTrace(
      "cf.scheduled.problem-counts",
      async () => {
        await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
          const [{ db }, { dispatchProblemCountsRefresh }] = await Promise.all([
            import("./server/db"),
            import("./server/background-dispatch"),
          ]);
          await dispatchProblemCountsRefresh(
            db,
            "maintenance",
            "cron.problem-counts",
            new Date(_controller.scheduledTime).toISOString(),
          );
        });
      },
      { "cubby.workload": "scheduled" },
    );
  },
};

export default Sentry.withSentry(
  () => ({
    dsn: SENTRY_DSN,
    sendDefaultPii: true,
    release: `cubby@${__GIT_COMMIT__}`,
    // Explicit rather than relying on the SDK default, which is also
    // "production" — stating it keeps the three init sites (here, router.tsx,
    // instrument.server.mjs) readable as a set, so a future reader can see at a
    // glance which one owns which environment. Branch preview deploys
    // (`versions upload`) also run this worker and so also report production;
    // they hit the prod database, so that is the honest label.
    environment: "production",
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
