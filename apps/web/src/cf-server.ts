/**
 * The web Worker entry. Sections, in file order:
 * - `handler.fetch`: env bridging, maintenance mode, direct sockets, then
 *   TanStack Start.
 * - `handler.queue`: `cubby-purchase-agent` (the purchase agent's consumer,
 *   `server/purchase-agent/queue`), `cubby-telemetry`, then background tasks
 *   (`server/background-tasks/consume`).
 * - `handler.scheduled`: the one daily maintenance cron.
 * - Durable Object and Workflow re-exports, then the Sentry-wrapped default.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger, originalLoggedError } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";
// CF Workers production entry point.
//
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, and fetch invocations use a per-request pg.Pool so a single
//    request's query fan-out runs in parallel instead of serializing.
// 3. Intercepts console.error to capture real error details for `wrangler tail`.
import type * as ServerEntry from "@tanstack/react-start/server-entry";

import { BROWSER_OPERATION_PATH } from "./lib/browser-operation-path";
import {
  TELEMETRY_SCHEMA_VERSION,
  withHtmlNoCache,
  withResponseDiagnostics,
} from "./lib/http-cache";
import { httpRouteTemplate } from "./lib/http-route-template";
import { observeResponseBody } from "./lib/response-body-observer";
import {
  readStartOperationTraceContext,
  startOperationTraceAttributes,
  startOperationTraceName,
} from "./lib/start-operation-observability";
import type { BackgroundQueueBatch } from "./server/background-queue-types";
import { runWithExecutionCtx, setCfEnv } from "./server/cf-env";
import { recordDatabaseWrite } from "./server/database-freshness/client";
import { withRequestDb, withRequestDbClient } from "./server/db";
import {
  requestOperations,
  serverTimingHeader,
  withDatabaseRequestMetrics,
} from "./server/db-observability";
import {
  IMAGE_PROCESSING_SOCKET_PATH,
  PURCHASE_IMPORT_SOCKET_PATH,
} from "./server/direct-socket-paths";
import {
  reportServerError,
  withErrorReporting,
} from "./server/errors/report-error";
import { withUnhandledErrorBody } from "./server/errors/unhandled-error-body";
import { isMaintenanceMode, maintenanceResponse } from "./server/maintenance";
import type { PurchaseAgentQueueBatch } from "./server/purchase-agent/environment";
import { purchaseAgentQueueEnvironment } from "./server/purchase-import/agent-host";
import type { SearchDocumentCursor } from "./server/repo/search-document";
import type { TelemetryQueueBatch } from "./server/telemetry-queue-types";
import {
  type AppSpan,
  getRequestId,
  withInvocationTrace,
  withManualTrace,
  withTrace,
} from "./server/tracing";
import { workerSentryOptions } from "./server/worker-sentry";
import { classifyHttpWorkload } from "./server/workload";

// Cache the handler module promise so the dynamic import only runs once (on
// first request). We keep it lazy (not a top-level static import) so that
// module-level errors are caught in the fetch() try/catch rather than becoming
// silent 500s.
let handlerPromise: Promise<typeof ServerEntry>;
let handlerImportState = "uninitialized";
const getHandler = () => {
  handlerPromise ??= (() => {
    handlerImportState = "pending";
    return import("@tanstack/react-start/server-entry").then(
      (module) => {
        handlerImportState = "ready";
        return module;
      },
      (error) => {
        handlerImportState = "failed";
        throw error;
      },
    );
  })();
  return handlerPromise;
};

let httpApiPromise: Promise<typeof import("./server/http-api")>;
let httpApiImportState = "uninitialized";
const getHttpApi = () => {
  httpApiPromise ??= (() => {
    httpApiImportState = "pending";
    return import("./server/http-api").then(
      (module) => {
        httpApiImportState = "ready";
        return module;
      },
      (error) => {
        httpApiImportState = "failed";
        throw error;
      },
    );
  })();
  return httpApiPromise;
};

let browserOperationPromise: Promise<
  typeof import("./server/browser-operation-dispatch")
>;
let browserOperationImportState = "uninitialized";
const getBrowserOperation = () => {
  browserOperationPromise ??= (() => {
    browserOperationImportState = "pending";
    return import("./server/browser-operation-dispatch").then(
      (module) => {
        browserOperationImportState = "ready";
        return module;
      },
      (error) => {
        browserOperationImportState = "failed";
        throw error;
      },
    );
  })();
  return browserOperationPromise;
};

const isHttpOperationPath = (pathname: string) =>
  pathname.startsWith("/api/v1/") &&
  pathname.replace(/\/+$/u, "") !== "/api/v1/docs";

// Per-request holder for the console.error-intercepted error, scoped via
// AsyncLocalStorage — mirrors withRequestDb's per-request pool store in
// server/db.ts. Workers reuse one isolate across concurrent in-flight
// requests, so a plain module-level `let` here would let request B's
// console.error reset/overwrite the value across an await before request A
// reads it, dropping A's real error or shipping B's as A's.
const interceptedErrorStore = new AsyncLocalStorage<{
  error: Error | null;
}>();

const _origError = console.error;
console.error = (...args: unknown[]) => {
  const holder = interceptedErrorStore.getStore();
  if (holder) {
    // `createLogger` passes errors inside its fields bag, so look one level in.
    for (const arg of args) {
      const directError = originalLoggedError(arg);
      if (directError) {
        holder.error = directError;
      } else if (arg instanceof Object) {
        for (const value of Object.values(arg)) {
          const error = originalLoggedError(value);
          if (error) holder.error = error;
        }
      }
    }
  }
  _origError(...args);
};

const log = createLogger("cf-server");
const cronLog = createLogger("cron");
const scheduledLog = createLogger("scheduled");

let fetchInvocationOrdinal = 0;

const handler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const startedAt = performance.now();
    const invocationOrdinal = ++fetchInvocationOrdinal;
    const runFetch = (entrySpan: AppSpan) =>
      withDatabaseRequestMetrics(entrySpan, async () => {
        await withTrace("cf.setup", async () => {
          // Bridge CF secrets → process.env for libraries that read from it
          // (better-auth reads BETTER_AUTH_SECRET from process.env at init time)
          process.env.BETTER_AUTH_SECRET ??= env.BETTER_AUTH_SECRET;
          process.env.ALLOW_SIGNUP ??= env.ALLOW_SIGNUP;
          process.env.E2E_AUTH_TEST_MODE = env.E2E_AUTH_TEST_MODE;
          if (env.E2E_GOOGLE_PROVIDER_URL)
            process.env.E2E_GOOGLE_PROVIDER_URL = env.E2E_GOOGLE_PROVIDER_URL;
          else delete process.env.E2E_GOOGLE_PROVIDER_URL;
          if (
            env.E2E_AUTH_TEST_MODE === "true" &&
            env.E2E_GOOGLE_PROVIDER_URL
          ) {
            process.env.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
            if (env.GOOGLE_CLIENT_SECRET)
              process.env.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
          }

          // Expose service bindings to server code (clients pick binding fetch
          // over public URLs when present).
          setCfEnv(env);
        });
        if (isMaintenanceMode(env)) {
          const response = maintenanceResponse(request);
          entrySpan.setAttributes({
            "http.response.status_code": response.status,
            "cubby.response.ready.duration_ms": Math.round(
              performance.now() - startedAt,
            ),
          });
          return response;
        }
        // cf.app.entry covers setup through response readiness; cf.fetch retains
        // the existing streamed-body lifetime beneath the platform root span.
        const url = new URL(request.url);
        const ray = request.headers.get("cf-ray") ?? undefined;
        const startTraceContext = url.pathname.startsWith("/_serverFn/")
          ? readStartOperationTraceContext(request.headers)
          : undefined;
        const routeTemplate = httpRouteTemplate(url.pathname, {
          serverFunction: startTraceContext !== undefined,
        });

        // Tag the whole request, not just the three captureException sites in this
        // file: an exception thrown deep inside a Start operation is captured by
        // Sentry's own instrumentation and never passes through here.
        // `Sentry.setTag` writes to the *isolation* scope, so this depends on
        // withSentry giving each request its own — it does in @sentry/cloudflare
        // (withSentry installs an AsyncLocalStorage context strategy and wraps the
        // handler in a per-invocation isolation scope), but that is an SDK
        // internal, so it gets confirmed on the preview deploy. If it ever stops
        // holding, the tag bleeds across concurrent requests in the same isolate,
        // and the replacement is the explicit
        // `captureException(err, { tags: { request_id } })` form at each call site —
        // not both.
        Sentry.setTag("request_id", ray);

        const readyResponse = await withErrorReporting(async () => {
          try {
            return await interceptedErrorStore.run({ error: null }, () =>
              withManualTrace(
                startTraceContext
                  ? `cf.fetch.${startOperationTraceName(startTraceContext)}`
                  : "cf.fetch",
                (span, endSpan) =>
                  url.pathname === "/.well-known/caldav" ||
                  url.pathname === "/.well-known/caldav/" ||
                  url.pathname === "/api/caldav" ||
                  url.pathname.startsWith("/api/caldav/")
                    ? withTrace("cf.caldav", async () => {
                        const response = await runWithExecutionCtx(
                          ctx,
                          async () =>
                            (
                              await import("./server/calendar/client")
                            ).handleCalDavRequest(request),
                          url.origin,
                        );
                        span.setAttribute(
                          "http.response.status_code",
                          response.status,
                        );
                        endSpan();
                        return withResponseDiagnostics(response, {
                          requestId: getRequestId(request.headers),
                          workerVersion: env.CF_VERSION_METADATA.id,
                        });
                      })
                    : (request.method === "GET" || request.method === "HEAD") &&
                        url.pathname.startsWith("/api/calendar/")
                      ? withTrace("cf.calendarFeed", async () => {
                          const response = await runWithExecutionCtx(
                            ctx,
                            async () => {
                              const [{ createCalendarFeedHandler }, calendar] =
                                await Promise.all([
                                  import("./server/calendar/feed"),
                                  import("./server/calendar/client"),
                                ]);
                              return createCalendarFeedHandler(
                                calendar.externalCalendarFeedStateFor,
                              )({ request });
                            },
                            url.origin,
                          );
                          span.setAttribute(
                            "http.response.status_code",
                            response.status,
                          );
                          endSpan();
                          return withResponseDiagnostics(response, {
                            requestId: getRequestId(request.headers),
                            workerVersion: env.CF_VERSION_METADATA.id,
                          });
                        })
                      : withRequestDb(
                          {
                            strong: env.HYPERDRIVE.connectionString,
                            boundedStale:
                              env.HYPERDRIVE_CACHED.connectionString,
                          },
                          async () => {
                            const imageProcessingSocket =
                              url.pathname === IMAGE_PROCESSING_SOCKET_PATH;
                            const purchaseImportSocket =
                              url.pathname === PURCHASE_IMPORT_SOCKET_PATH;
                            if (imageProcessingSocket || purchaseImportSocket) {
                              const response = await withTrace(
                                imageProcessingSocket
                                  ? "cf.imageProcessingSocket"
                                  : "cf.purchaseImportSocket",
                                () =>
                                  runWithExecutionCtx(
                                    ctx,
                                    async () =>
                                      imageProcessingSocket
                                        ? (
                                            await import("./server/image-processing/direct-socket-route")
                                          ).handleImageProcessingSocketUpgrade(
                                            request,
                                          )
                                        : (
                                            await import("./server/purchase-import/direct-socket-route")
                                          ).handleDirectBrowserSocketUpgrade(
                                            request,
                                          ),
                                    url.origin,
                                  ),
                              );
                              span.setAttribute(
                                "http.response.status_code",
                                response.status,
                              );
                              endSpan();
                              // Preserve Cloudflare's immutable 101 headers and
                              // non-standard WebSocket slot verbatim.
                              return response;
                            }
                            const invoke =
                              url.pathname === BROWSER_OPERATION_PATH
                                ? (
                                    await withTrace(
                                      "cf.importBrowserOperation",
                                      (importSpan) => {
                                        importSpan.setAttribute(
                                          "cubby.module.import_state",
                                          browserOperationImportState,
                                        );
                                        return getBrowserOperation();
                                      },
                                    )
                                  ).handleBrowserOperationDispatch
                                : isHttpOperationPath(url.pathname)
                                  ? (
                                      await withTrace(
                                        "cf.importHttpApi",
                                        (importSpan) => {
                                          importSpan.setAttribute(
                                            "cubby.module.import_state",
                                            httpApiImportState,
                                          );
                                          return getHttpApi();
                                        },
                                      )
                                    ).handleHttpOperation
                                  : (
                                      await withTrace(
                                        "cf.importHandler",
                                        (importSpan) => {
                                          importSpan.setAttribute(
                                            "cubby.module.import_state",
                                            handlerImportState,
                                          );
                                          return getHandler();
                                        },
                                      )
                                    ).default.fetch;
                            // Scoped here rather than around the whole handler body: this
                            // is the only region where request-scoped work runs, and
                            // waitUntil must belong to THIS request's context.
                            const handlerStartedAt = performance.now();
                            const response = await withTrace(
                              "cf.handler",
                              async () =>
                                runWithExecutionCtx(
                                  ctx,
                                  async () => invoke(request),
                                  url.origin,
                                ),
                            );
                            span.setAttribute(
                              "http.response.status_code",
                              response.status,
                            );

                            // If Nitro returned a 500 and we intercepted a real error, log the
                            // details so they appear in `wrangler tail` (Nitro's response body
                            // is useless) and report it to Sentry — the handler swallows it into
                            // a 500 body, so withSentry's auto-capture (thrown-error only) never
                            // sees it.
                            const interceptedError =
                              interceptedErrorStore.getStore()?.error;
                            let fallbackEventId: string | undefined;
                            if (response.status >= 500 && interceptedError) {
                              log.error("Unhandled error:", {
                                error: interceptedError,
                              });
                              fallbackEventId = reportServerError(
                                interceptedError,
                                {
                                  requestId: getRequestId(request.headers),
                                },
                              );
                            }

                            const responsePreparationStartedAt =
                              performance.now();
                            const correlatedResponse = withResponseDiagnostics(
                              withHtmlNoCache(
                                response.status >= 500 && interceptedError
                                  ? await withUnhandledErrorBody(
                                      response,
                                      interceptedError,
                                    )
                                  : response,
                              ),
                              {
                                requestId: getRequestId(request.headers),
                                workerVersion: env.CF_VERSION_METADATA.id,
                              },
                            );
                            span.setAttribute(
                              "cubby.response.prepare.duration_ms",
                              Math.round(
                                performance.now() -
                                  responsePreparationStartedAt,
                              ),
                            );
                            if (fallbackEventId)
                              correlatedResponse.headers.set(
                                "x-sentry-event-id",
                                fallbackEventId,
                              );
                            if (correlatedResponse.status !== 101)
                              correlatedResponse.headers.set(
                                "server-timing",
                                serverTimingHeader(
                                  performance.now() - handlerStartedAt,
                                  invocationOrdinal,
                                ),
                              );
                            if (request.method === "HEAD") {
                              span.setAttributes({
                                "cubby.response.body.outcome": "empty",
                                "cubby.response.stream.duration_ms": 0,
                              });
                              endSpan();
                              return correlatedResponse;
                            }
                            // Captured by reference: a batch names its
                            // operations as they run, after this returns.
                            const operations = requestOperations();
                            return observeResponseBody(
                              correlatedResponse,
                              (observation) => {
                                if (operations.length > 0)
                                  span.setAttribute(
                                    "cubby.operations",
                                    operations.join(" "),
                                  );
                                span.setAttributes({
                                  "cubby.response.body.outcome":
                                    observation.outcome,
                                  "cubby.response.stream.duration_ms":
                                    Math.round(observation.durationMs),
                                  "cubby.response.cancelled":
                                    observation.outcome === "cancelled",
                                });
                                if (observation.outcome === "error") {
                                  span.setError("response_stream_error");
                                }
                                endSpan();
                              },
                            );
                          },
                        ),
                {
                  "http.request.method": request.method,
                  "http.route": routeTemplate,
                  "server.address": url.hostname,
                  "service.version": env.CF_VERSION_METADATA.id,
                  "cloudflare.worker.version.tag": env.CF_VERSION_METADATA.tag,
                  "cloudflare.worker.version.timestamp":
                    env.CF_VERSION_METADATA.timestamp,
                  "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
                  "cubby.workload": classifyHttpWorkload(
                    url.pathname,
                    request.headers,
                  ),
                  // Load-bearing, not decoration: the ray is the id we hand back to
                  // the client in `x-request-id` (getRequestId falls back to it under
                  // CF), and this attribute is the only thing that makes that id
                  // findable in Tempo. Dropping it makes every reported id a dead
                  // end. Undefined values are skipped by both span backends.
                  "cloudflare.ray_id": ray,
                  ...startOperationTraceAttributes(startTraceContext),
                },
              ),
            );
          } catch (error) {
            // Report to Sentry before swallowing: we return a generic 500 rather than
            // rethrowing, so withSentry's auto-capture would otherwise miss this.
            const eventId = reportServerError(error, {
              requestId: getRequestId(request.headers),
            });
            // Log full detail server-side (visible in `wrangler tail`) but never
            // return the stack/message to the client — avoids stack-trace exposure.
            const detail =
              error instanceof Error
                ? `${error.constructor.name}: ${error.message}\n${error.stack}`
                : String(error);
            log.error(detail);
            const headers = new Headers({ "cache-control": "no-store" });
            const requestId = getRequestId(request.headers);
            if (requestId) headers.set("x-request-id", requestId);
            if (eventId) headers.set("x-sentry-event-id", eventId);
            return new Response("Internal Server Error", {
              status: 500,
              headers,
            });
          }
        }, request.headers);
        entrySpan.setAttributes({
          "http.response.status_code": readyResponse.status,
          "cubby.response.ready.duration_ms": Math.round(
            performance.now() - startedAt,
          ),
        });
        return readyResponse;
      });
    return withInvocationTrace("cf.app.entry", runFetch, {
      "http.request.method": request.method,
      "http.route": httpRouteTemplate(new URL(request.url).pathname),
      "cubby.worker.invocation_ordinal": invocationOrdinal,
      "cubby.worker.first_invocation": invocationOrdinal === 1,
      "cloudflare.ray_id": request.headers.get("cf-ray") ?? undefined,
      "service.version": env.CF_VERSION_METADATA.id,
      "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      "cubby.workload": classifyHttpWorkload(
        new URL(request.url).pathname,
        request.headers,
      ),
    });
  },

  // Background queue consumer. Each message is a complete task; there is no
  // execution row behind it. Per-message ack/retry so one failing task never
  // replays its siblings, and the queue's own retry budget is the only retry.
  async queue(
    batch: BackgroundQueueBatch | TelemetryQueueBatch | PurchaseAgentQueueBatch,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    setCfEnv(env);
    await withInvocationTrace(
      "cf.queue",
      async () => {
        if (batch.queue === "cubby-purchase-agent") {
          // The agent's consumer holds no database client: each Run service it
          // calls opens its own (`server/purchase-import/agent-services`).
          const { consumePurchaseAgentQueue } =
            await import("./server/purchase-agent/queue");
          await consumePurchaseAgentQueue(
            batch,
            purchaseAgentQueueEnvironment(env, ctx),
          );
          return;
        }

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

          // Imported here, not at module scope: the consumer pulls
          // @earendil-works/pi-ai + its lazy provider API modules +
          // @anthropic-ai/sdk (~553 KiB, plus a second copy of zod) and only
          // queue deliveries need it. A static import puts all of that on
          // the module-init path of every fetch invocation too.
          const [{ db }, { handleBackgroundQueueBatch }] = await Promise.all([
            import("./server/db"),
            import("./server/background-tasks/consume"),
          ]);
          await handleBackgroundQueueBatch(db, batch, {
            captureException: (error) => {
              Sentry.captureException(error);
            },
            // The calendar projection reads only meal/task rows
            // (`repo/calendar-caldav`), which no background task kind
            // writes — marking it dirty here scheduled a full re-projection
            // after every batch (~1,000 during one backfill).
            afterSuccess: async () => {
              await recordDatabaseWrite("background-job");
            },
          });
        });
      },
      {
        "cubby.workload": "queue",
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    );
  },

  async scheduled(
    controller: { scheduledTime: number; cron: string },
    env: Env,
  ) {
    setCfEnv(env);
    return withInvocationTrace(
      "cf.scheduled",
      async () => {
        if (isMaintenanceMode(env)) {
          cronLog.warn("skipped: maintenance mode");
          return;
        }
        if (controller.cron !== "0 12 * * *")
          throw new Error(`Unexpected cron trigger: ${controller.cron}`);
        await Sentry.withMonitor(
          "daily-maintenance",
          async () => {
            try {
              await withRequestDbClient(
                env.HYPERDRIVE.connectionString,
                async () => {
                  const [
                    { db },
                    { claimCatchUp, discoverPurchases, recoverMissedWork },
                  ] = await Promise.all([
                    import("./server/db"),
                    import("./server/services/catch-up.service"),
                  ]);
                  const claimedAt = new Date();
                  if (await claimCatchUp(db, claimedAt)) {
                    const jobs = await Promise.allSettled([
                      withTrace(
                        "cf.scheduled.job",
                        () => recoverMissedWork(db),
                        {
                          "cubby.scheduled.job": "recover-missed-work",
                        },
                      ),
                      withTrace(
                        "cf.scheduled.job",
                        () => discoverPurchases(db),
                        {
                          "cubby.scheduled.job": "purchase-discovery",
                        },
                      ),
                    ]);
                    for (const job of jobs)
                      if (job.status === "rejected")
                        Sentry.captureException(job.reason);
                  }
                },
              );
            } catch (error) {
              Sentry.captureException(error);
            }
            try {
              await withTrace(
                "cf.scheduled.job",
                async () =>
                  await (
                    await (
                      await import("./server/calendar/client")
                    ).calendarFeedStateFor(env.APP_ORIGIN)
                  ).refreshNow("cron.daily"),
                { "cubby.scheduled.job": "calendar-feed" },
              );
            } catch (error) {
              // Calendar keeps serving its previous atomic snapshot. Keep the
              // independent assertion below running while surfacing the failure
              // through both the errored child span and Sentry.
              Sentry.captureException(error);
            }
            // The clock is a legitimate input for the calendar above. This job is
            // not a repair: it only reads the markers that "Settle now" acts on
            // and reports when they are non-zero, which is the evidence that a
            // wakeup was lost — the cue to look, not a sweep that would hide it.
            // (The vector-reconcile job below IS a repair — see its comment.)
            try {
              await withRequestDbClient(
                env.HYPERDRIVE.connectionString,
                async () => {
                  const [{ db }, { countAwaitingWork }] = await Promise.all([
                    import("./server/db"),
                    import("./server/services/awaiting-work.service"),
                  ]);
                  await withTrace(
                    "cf.scheduled.job",
                    async (span) => {
                      try {
                        const awaiting = await countAwaitingWork(db);
                        span.setAttributes({
                          "cubby.awaiting.stale_recipe_totals":
                            awaiting.staleRecipeTotals,
                          "cubby.awaiting.unembedded_entities":
                            awaiting.unembeddedEntities,
                          "cubby.awaiting.pending_uploads":
                            awaiting.pendingUploads,
                        });
                        scheduledLog.info("awaiting work", awaiting);
                        if (
                          awaiting.staleRecipeTotals > 0 ||
                          awaiting.unembeddedEntities > 0 ||
                          awaiting.pendingUploads > 0
                        ) {
                          Sentry.captureMessage(
                            `Derived work is waiting: ${awaiting.staleRecipeTotals} stale recipe totals, ${awaiting.unembeddedEntities} unembedded entities, ${awaiting.pendingUploads} pending uploads`,
                            "warning",
                          );
                        }
                      } catch (error) {
                        span.setError("Awaiting-work assertion failed");
                        Sentry.captureException(error);
                      }
                    },
                    { "cubby.scheduled.job": "awaiting-work-assertion" },
                  );
                },
              );
            } catch (error) {
              Sentry.captureException(error);
            }
            // This job IS a repair, unlike the assert-only sibling above:
            // Vectorize cannot join the Postgres transaction that soft-deletes
            // `SearchDocument`/`EntityEmbedding` (`softDeleteEntitySearchArtifactsTx`),
            // so a removed entity's vector otherwise lingers in Vectorize forever.
            // `deleteByIds` is idempotent, so re-running or overlapping passes
            // over the same refs are safe.
            try {
              await withTrace(
                "cf.scheduled.job",
                async (span) => {
                  const { semanticEmbeddingsConfigured } =
                    await import("./server/semantic/embeddings");
                  if (!semanticEmbeddingsConfigured()) {
                    span.setAttribute("cubby.vectorReconcile.skipped", true);
                    return;
                  }
                  await withRequestDbClient(
                    env.HYPERDRIVE.connectionString,
                    async () => {
                      const [
                        { db },
                        { selectRecentlySoftDeletedSearchRefs },
                        { productionVectorStore },
                      ] = await Promise.all([
                        import("./server/db"),
                        import("./server/repo/entity-embedding-cleanup"),
                        import("./server/semantic/vector-store"),
                      ]);
                      const since = new Date(
                        Date.now() - 7 * 24 * 60 * 60 * 1000,
                      );
                      let cursor: SearchDocumentCursor | undefined;
                      let deletedCount = 0;
                      do {
                        const page = await selectRecentlySoftDeletedSearchRefs(
                          db,
                          {
                            since,
                            cursor,
                          },
                        );
                        if (page.refs.length > 0) {
                          await productionVectorStore.deleteByIds(page.refs);
                          deletedCount += page.refs.length;
                        }
                        cursor = page.nextCursor ?? undefined;
                      } while (cursor);
                      span.setAttribute(
                        "cubby.vectorReconcile.deletedCount",
                        deletedCount,
                      );
                    },
                  );
                },
                { "cubby.scheduled.job": "vector-reconcile" },
              );
            } catch (error) {
              // Mirror the calendar job above: report and move on rather than
              // failing the whole scheduled invocation over one job.
              Sentry.captureException(error);
            }
          },
          {
            schedule: { type: "crontab", value: "0 12 * * *" },
            checkinMargin: 10,
            maxRuntime: 30,
            timezone: "Etc/UTC",
            failureIssueThreshold: 1,
            recoveryThreshold: 1,
          },
        );
      },
      {
        "cubby.workload": "scheduled",
        "cloudflare.cron": controller.cron,
        "cloudflare.scheduled_time": controller.scheduledTime,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    );
  },
};

// Named exports: `wrangler types` finds Durable Object classes by reading them.
export { AiResponseCacheDurableObject } from "./server/ai/response-cache-durable-object";
export { ChatGptPlanDurableObject } from "./server/ai/chatgpt/durable-object";
export { CalendarFeedDurableObject } from "./server/calendar/durable-object";
export { DatabaseFreshnessDurableObject } from "./server/database-freshness/durable-object";
export { ImageProcessingDurableObject } from "./server/image-processing/durable-object";
export { PurchaseImportRunAgent } from "./server/purchase-import/agent-host";
export { PurchaseImportDurableObject } from "./server/purchase-import/durable-object";
export { SearchIndexRepairWorkflow } from "./server/search-index-repair-workflow";
export {
  MailDiscoveryWorkflow,
  VendorMailSearchWorkflow,
} from "./server/gmail-workflows";

export default Sentry.withSentry(workerSentryOptions, handler);
