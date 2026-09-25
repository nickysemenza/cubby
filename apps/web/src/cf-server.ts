import { AsyncLocalStorage } from "node:async_hooks";

import * as Sentry from "@sentry/cloudflare";
// CF Workers production entry point.
//
// 1. Dynamic import catches module-level errors (which would otherwise be silent 500s)
// 2. Per-request database connections via withRequestDb — Hyperdrive provides pooled
//    TCP connections, and fetch invocations use a per-request pg.Pool so a single
//    request's query fan-out runs in parallel instead of serializing.
// 3. Intercepts console.error to capture real error details for `wrangler tail`.
import type * as ServerEntry from "@tanstack/react-start/server-entry";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  TELEMETRY_SCHEMA_VERSION,
  withHtmlNoCache,
  withResponseDiagnostics,
} from "./lib/http-cache";
import { httpRouteTemplate } from "./lib/http-route-template";
import { observeResponseBody } from "./lib/response-body-observer";
import { SENTRY_DSN } from "./lib/sentry-dsn";
import { resolveWorkerSentryEnvironment } from "./lib/sentry-environment";
import { SENTRY_IGNORED_ERRORS } from "./lib/sentry-noise";
import { scrubSentryEvent } from "./lib/sentry-scrub";
import { rewriteLegacyStartRequest } from "./lib/start-dispatch-url";
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
  IMAGE_PROCESSING_SOCKET_PATH,
  PURCHASE_IMPORT_SOCKET_PATH,
} from "./server/direct-socket-paths";
import {
  reportServerError,
  withErrorReporting,
} from "./server/errors/report-error";
import {
  resolvePurchaseAgentBrowserOperation,
  type PurchaseAgentCommand,
} from "./server/purchase-import/agent-browser-command";
import type { SearchDocumentCursor } from "./server/repo/search-document";
import type { TelemetryQueueBatch } from "./server/telemetry-queue-types";
import { getRequestId, withManualTrace, withTrace } from "./server/tracing";
import { classifyHttpWorkload } from "./server/workload";

// Cache the handler module promise so the dynamic import only runs once (on
// first request). We keep it lazy (not a top-level static import) so that
// module-level errors are caught in the fetch() try/catch rather than becoming
// silent 500s.
let handlerPromise: Promise<typeof ServerEntry>;
const getHandler = () => {
  handlerPromise ??= import("@tanstack/react-start/server-entry");
  return handlerPromise;
};

let httpApiPromise: Promise<typeof import("./server/http-api")>;
const getHttpApi = () => {
  httpApiPromise ??= import("./server/http-api");
  return httpApiPromise;
};

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
    for (const arg of args) {
      if (arg instanceof Error) {
        holder.error = arg;
      }
    }
  }
  _origError(...args);
};

const handler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
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
    // a multi-second root with a sub-second Start child, the gap localizes here:
    //  - cf.fetch ≈ root  → the time is in our code; the children below say where
    //  - cf.fetch ≪ root  → it's platform queue/dispatch (cold isolate, request
    //                       waiting for a worker) or response-body flush — not us
    // cf.importHandler isolates the first-request dynamic import of the (large)
    // server bundle; cf.handler is the TanStack handler up to the Response being
    // ready (the streamed body finishes after, outside the span).
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

    return await withErrorReporting(async () => {
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
                        boundedStale: env.HYPERDRIVE_CACHED.connectionString,
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
                        const handlerImport = withTrace(
                          "cf.importHandler",
                          () => getHandler(),
                        );
                        const httpApiImport = url.pathname.startsWith(
                          "/api/v1/",
                        )
                          ? withTrace("cf.importHttpApi", () => getHttpApi())
                          : Promise.resolve(undefined);
                        const [{ default: handler }] = await Promise.all([
                          handlerImport,
                          httpApiImport,
                        ]);
                        // Scoped here rather than around the whole handler body: this
                        // is the only region where request-scoped work runs, and
                        // waitUntil must belong to THIS request's context.
                        const response = await withTrace(
                          "cf.handler",
                          async () =>
                            runWithExecutionCtx(
                              ctx,
                              async () =>
                                handler.fetch(
                                  rewriteLegacyStartRequest(request),
                                ),
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
                          console.error(
                            "[cf-server] Unhandled error:",
                            interceptedError,
                          );
                          fallbackEventId = reportServerError(
                            interceptedError,
                            {
                              requestId: getRequestId(request.headers),
                            },
                          );
                        }

                        const correlatedResponse = withResponseDiagnostics(
                          withHtmlNoCache(response),
                          {
                            requestId: getRequestId(request.headers),
                            workerVersion: env.CF_VERSION_METADATA.id,
                          },
                        );
                        if (fallbackEventId)
                          correlatedResponse.headers.set(
                            "x-sentry-event-id",
                            fallbackEventId,
                          );
                        if (request.method === "HEAD") {
                          span.setAttributes({
                            "cubby.response.body.outcome": "empty",
                            "cubby.response.stream.duration_ms": 0,
                          });
                          endSpan();
                          return correlatedResponse;
                        }
                        return observeResponseBody(
                          correlatedResponse,
                          (observation) => {
                            span.setAttributes({
                              "cubby.response.body.outcome":
                                observation.outcome,
                              "cubby.response.stream.duration_ms": Math.round(
                                observation.durationMs,
                              ),
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
        console.error("[cf-server]", detail);
        const headers = new Headers({ "cache-control": "no-store" });
        const requestId = getRequestId(request.headers);
        if (requestId) headers.set("x-request-id", requestId);
        if (eventId) headers.set("x-sentry-event-id", eventId);
        return new Response("Internal Server Error", { status: 500, headers });
      }
    }, request.headers);
  },

  // Background queue consumer. Each message is a complete task; there is no
  // execution row behind it. Per-message ack/retry so one failing task never
  // replays its siblings, and the queue's own retry budget is the only retry.
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

          // Imported here, not at module scope: the consumer pulls
          // @tanstack/ai + its provider adapters + @anthropic-ai/sdk
          // (~553 KiB, plus a second copy of zod) and only queue deliveries
          // need it. A static import puts all of that on the module-init
          // path of every fetch invocation too.
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
      },
    );
  },

  async scheduled(
    controller: { scheduledTime: number; cron: string },
    env: Env,
  ) {
    setCfEnv(env);
    if (controller.cron !== "0 12 * * *")
      throw new Error(`Unexpected cron trigger: ${controller.cron}`);
    await Sentry.withMonitor(
      "daily-maintenance",
      async () => {
        await withTrace(
          "cf.scheduled",
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
                        console.log("[scheduled] awaiting work", awaiting);
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
            "cubby.workload": "scheduled",
            // The trigger's identity lives in attributes rather than the span name:
            // a hardcoded `cf.scheduled.problem-counts` would silently mislabel the
            // trigger on the worker.
            "cloudflare.cron": controller.cron,
          },
        );
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
};

/**
 * Private RPC boundary for the Flue Worker. Every method resolves authority
 * from the ImportRun; the caller cannot supply a party, account, vendor, SQL,
 * script, or generic mutation target.
 */
export class PurchaseImportService extends WorkerEntrypoint<Env> {
  private withDatabase<T>(
    fn: (
      database: typeof import("./server/db").db,
      service: typeof import("./server/purchase-import/run-service"),
    ) => Promise<T>,
  ): Promise<T> {
    setCfEnv(this.env);
    return runWithExecutionCtx(this.ctx, () =>
      withRequestDbClient(this.env.HYPERDRIVE.connectionString, async () => {
        const [{ db }, service] = await Promise.all([
          import("./server/db"),
          import("./server/purchase-import/run-service"),
        ]);
        return fn(db, service);
      }),
    );
  }

  loadRunScope(input: { runId: string }) {
    return this.withDatabase((db, service) =>
      service.loadRunScope(db, input.runId),
    );
  }

  canDispatchCoordinator(input: { runId: string; eventId: string }) {
    return this.withDatabase((db, service) =>
      service.canDispatchImportRunCoordinator(db, input),
    );
  }

  acknowledgeCoordinator(input: { runId: string; eventId: string }) {
    return this.withDatabase((db, service) =>
      service.acknowledgeImportRunCoordinator(db, input),
    );
  }

  acquireMcpAccess(input: { runId: string }) {
    return this.withDatabase(async (db, service) => {
      const scope = await service.loadRunScope(db, input.runId);
      const { findActivePurchaseAgentGrant, issuePurchaseAgentDelegation } =
        await import("./server/purchase-import/agent-auth");
      const grant = await findActivePurchaseAgentGrant(db, scope.actorUserId);
      if (!grant) {
        await service.pauseImportRunForAuthorization(db, input.runId);
        throw new Error("Purchase Agent authorization is required");
      }
      const token = await issuePurchaseAgentDelegation({
        runId: input.runId,
        userId: scope.actorUserId,
        grantId: grant.id,
        secret: this.env.BETTER_AUTH_SECRET,
      });
      return {
        token,
        expiresAt: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
        mcpUrl: "https://cubby.internal/api/mcp",
      };
    });
  }

  mcpFetch(request: Request) {
    return this.withDatabase(async () => {
      const { handleMcpHttpRequest } =
        await import("./server/mcp/http-handler");
      return await handleMcpHttpRequest(request);
    });
  }

  claimNextWork(input: { runId: string; operationId: string }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "claim_next_work", payload: input },
        () =>
          service.claimNextImportWork(
            db,
            this.env.PURCHASE_IMPORT,
            input.runId,
          ),
      ),
    );
  }

  extractReceiptEvidence(input: { runId: string; operationId: string }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "extract_receipt_evidence", payload: input },
        async () => {
          const [{ extractPurchaseReceipt }, { loadReceiptEvidenceForRun }] =
            await Promise.all([
              import("./server/agents/purchase-import/extract"),
              import("./server/purchase-import/receipt-evidence"),
            ]);
          const evidence = await loadReceiptEvidenceForRun(db, input.runId);
          if (!evidence)
            throw new Error("This run has no pending receipt evidence");
          const extraction = await extractPurchaseReceipt({
            db,
            runId: input.runId,
            imageUrl: evidence.imageUrl,
          });
          return {
            stableOrderId: `receipt:${evidence.huntId}`,
            itemOperationId: `receipt:${evidence.huntId}`,
            source: evidence.source,
            evidenceChecksum: evidence.evidenceChecksum,
            extractionRevision: "receipt@1",
            extraction,
            lineIds: (extraction.candidate?.lines ?? []).map(
              (_line, index) => `receipt:${evidence.huntId}:line:${index}`,
            ),
            primaryDocumentImageId: evidence.imageId,
            screenshotImageId: null,
          };
        },
      ),
    );
  }

  extractRunEvidence(input: { runId: string; operationId: string }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "extract_run_evidence", payload: input },
        async () => {
          const [
            { extractPurchaseEvidence },
            { loadRunEvidenceForExtraction },
          ] = await Promise.all([
            import("./server/agents/purchase-import/extract"),
            import("./server/purchase-import/run-evidence"),
          ]);
          const evidence = await loadRunEvidenceForExtraction(db, input.runId);
          if (!evidence)
            throw new Error("This validation run has no uploaded evidence");
          const extraction = await extractPurchaseEvidence({
            db,
            runId: input.runId,
            evidenceUrl: evidence.evidenceUrl,
            mediaType: evidence.mediaType,
          });
          return {
            stableOrderId: `run-evidence:${evidence.id}`,
            itemOperationId: `run-evidence:${evidence.id}`,
            source: {
              kind: evidence.sourceKind ?? "receipt_photo",
              externalKey: evidence.sourceExternalKey ?? evidence.id,
              checksum: evidence.checksum,
            },
            evidenceChecksum: evidence.checksum,
            extractionRevision: "run-evidence@1",
            extraction,
            lineIds: (extraction.candidate?.lines ?? []).map(
              (_line, index) => `run-evidence:${evidence.id}:line:${index}`,
            ),
            primaryDocumentImageId: null,
            screenshotImageId: null,
          };
        },
      ),
    );
  }

  issueBrowserCommand(input: {
    runId: string;
    operationId: string;
    command: PurchaseAgentCommand;
  }) {
    return this.withDatabase(async (db, service) => {
      const scope = await service.loadRunScope(db, input.runId);
      if (!scope.public.vendorAccountId)
        throw new Error("This import run has no browser account");
      const claimed = await service.claimNextImportWork(
        db,
        this.env.PURCHASE_IMPORT,
        input.runId,
      );
      const claimedTarget = "startUrl" in claimed ? claimed.startUrl : null;
      const operation = resolvePurchaseAgentBrowserOperation(
        input.command,
        claimedTarget,
        scope.public.allowedHosts,
      );
      return service.issueBrowserCommand(db, this.env.PURCHASE_IMPORT, {
        runId: input.runId,
        operationId: input.operationId,
        operation,
      });
    });
  }

  readBrowserCommandResult(input: { runId: string; operationId: string }) {
    return this.withDatabase((db, service) =>
      service.readBrowserCommandResult(db, this.env.PURCHASE_IMPORT, input),
    );
  }

  recordAgentUsage(input: {
    runId: string;
    eventId: string;
    provider: string;
    model: string;
    feature: "purchase_import_agent";
    operation: string;
    attempt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    durationMs: number;
    status: "succeeded" | "failed";
    gatewayLogId?: string;
    estimatedCost?: number;
  }) {
    return this.withDatabase(async (db) => {
      const { recordAiUsage } = await import("./server/ai-usage");
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `purchase-agent:${input.runId}:${input.eventId}`,
          ),
        ),
      );
      digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
      digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(digest.slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const { runId, ...rest } = input;
      const { importRunId } = await import("@cubby/schemas/identifiers");
      await recordAiUsage(db, {
        ...rest,
        eventId,
        runId: importRunId.parse(runId),
        cacheStatus:
          input.cacheReadTokens > 0 || input.cacheWriteTokens > 0
            ? "hit"
            : "none",
      });
    });
  }

  updateAgentProgress(input: {
    runId: string;
    eventId: string;
    phase: string;
    currentItem?: string;
    awaitingApproval?: boolean;
    detail?: string;
  }) {
    return this.withDatabase((db, service) =>
      service.updateAgentProgress(db, input),
    );
  }

  importOrderEvidence(input: {
    runId: string;
    operationId: string;
    commandId: string;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "import_order_evidence", payload: input },
        () =>
          service.importBrowserOrderEvidence(
            db,
            this.env.PURCHASE_IMPORT,
            input,
          ),
      ),
    );
  }

  saveNavigationHints(input: {
    runId: string;
    operationId: string;
    hints: Array<{ url: string; label?: string }>;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "save_navigation_hints", payload: input },
        () =>
          service.saveNavigationHints(db, {
            runId: input.runId,
            operationId: input.operationId,
            patch: {
              ordersListUrl: input.hints[0]?.url,
              notes: input.hints
                .map((hint) => hint.label)
                .filter((label): label is string => Boolean(label)),
            },
          }),
      ),
    );
  }

  markHistoryExpired(input: {
    runId: string;
    operationId: string;
    earliestAvailableOrderAt: string;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "mark_history_expired", payload: input },
        () => service.markHistoryExpired(db, input),
      ),
    );
  }

  auditBatch(input: { runId: string; operationId: string; offset: number }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "audit_batch", payload: input },
        () => service.auditImportBatch(db, input),
      ),
    );
  }

  finishRun(input: { runId: string; operationId: string }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "finish_run", payload: input },
        () => service.finishImportRun(db, this.env.PURCHASE_IMPORT, input),
      ),
    );
  }

  stopForReview(input: {
    runId: string;
    operationId: string;
    reason:
      | "navigation_ambiguity"
      | "unreadable_evidence"
      | "provider_failure"
      | "other";
    detail?: string;
  }) {
    const kind =
      input.reason === "navigation_ambiguity"
        ? "expected_order_not_found"
        : "other";
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "stop_for_review", payload: input },
        () =>
          service.stopImportRunForReview(db, {
            runId: input.runId,
            operationId: input.operationId,
            kind,
            summary: input.detail ?? input.reason.replaceAll("_", " "),
          }),
      ),
    );
  }

  markRunFailed(input: {
    runId: string;
    operationId: string;
    failureCode: "flue_failed" | "flue_aborted";
    detail?: string;
    dispatchEventId?: string;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "mark_run_failed", payload: input },
        () => service.markImportRunFailed(db, input),
      ),
    );
  }

  reconcileSettledRun(input: {
    runId: string;
    operationId: string;
    detail?: string;
  }) {
    return this.withDatabase((db, service) =>
      service.reconcileSettledImportRun(db, this.env.PURCHASE_IMPORT, input),
    );
  }
}

export { CalendarFeedDurableObject } from "./server/calendar/durable-object";
export { PurchaseImportDurableObject } from "./server/purchase-import/durable-object";
export { ImageProcessingDurableObject } from "./server/image-processing/durable-object";
export { SearchIndexRepairWorkflow } from "./server/search-index-repair-workflow";

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: SENTRY_DSN,
    // The e2e harness identity (see `tests/e2e/e2e-worker-runtime.ts`) must
    // never ship envelopes to the real DSN.
    enabled: env.E2E_AUTH_TEST_MODE !== "true",
    sendDefaultPii: false,
    release: `cubby@${__GIT_COMMIT__}`,
    // Covers queue/cron events without request URLs. Deployed previews retain
    // production reporting (NODE_ENV stays "production" there;
    // only `preview:cf`'s local `wrangler dev` overrides it to "development")
    // because they access the production database.
    environment: resolveWorkerSentryEnvironment(env),
    // Keep the scrubber as defense in depth for manually attached request data,
    // even though the SDK no longer sends default PII.
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    // Drop known-noise messages before send — free-plan quota hygiene.
    ignoreErrors: SENTRY_IGNORED_ERRORS,
    // Cloudflare native tracing already exports server spans. A sampled
    // browser `sentry-trace` header overrides `tracesSampleRate: 0` in Sentry,
    // so use a sampler to decline even inherited performance traces. Error
    // capture remains enabled.
    tracesSampler: () => 0,
  }),
  handler,
);

export { DatabaseFreshnessDurableObject } from "./server/database-freshness/durable-object";
export { AiResponseCacheDurableObject } from "./server/ai/response-cache-durable-object";
