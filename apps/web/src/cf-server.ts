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
import { scrubSentryEvent } from "./lib/sentry-scrub";
import {
  readStartOperationTraceContext,
  startOperationTraceAttributes,
  startOperationTraceName,
} from "./lib/start-operation-observability";
import type { BackgroundQueueBatch } from "./server/background-queue-types";
import {
  calendarFeedStateFor,
  externalCalendarFeedStateFor,
  handleCalDavRequest,
} from "./server/calendar/client";
import { createCalendarFeedHandler } from "./server/calendar/feed";
import { runWithExecutionCtx, setCfEnv } from "./server/cf-env";
import { recordDatabaseWrite } from "./server/database-freshness/client";
import { withRequestDb, withRequestDbClient } from "./server/db";
import {
  handleDirectBrowserSocketUpgrade,
  isDirectBrowserSocketUpgrade,
} from "./server/purchase-import/direct-socket-route";
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

const calendarFeedHandler = createCalendarFeedHandler((origin) =>
  externalCalendarFeedStateFor(origin),
);

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
                    () => handleCalDavRequest(request),
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
                      async () => await calendarFeedHandler({ request }),
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
                      if (isDirectBrowserSocketUpgrade(request)) {
                        const response = await withTrace(
                          "cf.purchaseImportSocket",
                          () =>
                            runWithExecutionCtx(
                              ctx,
                              () => handleDirectBrowserSocketUpgrade(request),
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
                      const handlerImport = withTrace("cf.importHandler", () =>
                        getHandler(),
                      );
                      const httpApiImport = url.pathname.startsWith("/api/v1/")
                        ? withTrace("cf.importHttpApi", () => getHttpApi())
                        : Promise.resolve(undefined);
                      const [{ default: handler }] = await Promise.all([
                        handlerImport,
                        httpApiImport,
                      ]);
                      // Scoped here rather than around the whole handler body: this
                      // is the only region where request-scoped work runs, and
                      // waitUntil must belong to THIS request's context.
                      const response = await withTrace("cf.handler", async () =>
                        runWithExecutionCtx(
                          ctx,
                          async () => handler.fetch(request),
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
                      if (response.status >= 500 && interceptedError) {
                        console.error(
                          "[cf-server] Unhandled error:",
                          JSON.stringify(interceptedError, null, 2),
                        );
                        const reconstructed = new Error(
                          interceptedError.message,
                        );
                        reconstructed.name = interceptedError.name;
                        reconstructed.stack = interceptedError.stack;
                        reconstructed.cause = interceptedError.cause;
                        Sentry.captureException(reconstructed);
                      }

                      const correlatedResponse = withResponseDiagnostics(
                        withHtmlNoCache(response),
                        {
                          requestId: getRequestId(request.headers),
                          workerVersion: env.CF_VERSION_METADATA.id,
                        },
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
                            "cubby.response.body.outcome": observation.outcome,
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
    if (controller.cron === "0 * * * *") {
      // SAFETY: Worker secrets are runtime bindings intentionally absent from
      // generated Wrangler types; both values are checked before use.
      const google = env as Env & {
        GOOGLE_CLIENT_ID?: string;
        GOOGLE_CLIENT_SECRET?: string;
      };
      if (!google.GOOGLE_CLIENT_ID || !google.GOOGLE_CLIENT_SECRET) {
        console.log(
          "[scheduled] Gmail discovery skipped: Google OAuth is not configured",
        );
        return;
      }
      await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
        const [
          { db },
          { runGmailHourlySync },
          { createBetterAuthGmailAccountStore },
          { createGmailProviderFactory },
          { listGmailSyncTargets },
          { discoverImportHunts, dispatchImportHunts },
          { processOrderMails },
        ] = await Promise.all([
          import("./server/db"),
          import("./server/purchase-import/gmail/hourly"),
          import("./server/purchase-import/gmail/persistence"),
          import("./server/purchase-import/gmail/tokens"),
          import("./server/purchase-import/gmail/targets"),
          import("./server/purchase-import/hunts"),
          import("./server/purchase-import/gmail/process"),
        ]);
        const store = createBetterAuthGmailAccountStore(db);
        const huntsCreated = await discoverImportHunts(db);
        console.log("[scheduled] Purchase hunts created", { huntsCreated });
        const summary = await runGmailHourlySync({
          db,
          listTargets: () => listGmailSyncTargets(db),
          providerForUser: createGmailProviderFactory({
            store,
            clientId: google.GOOGLE_CLIENT_ID!,
            clientSecret: google.GOOGLE_CLIENT_SECRET!,
          }),
          includeAttachmentData: true,
          processMessages: processOrderMails,
        });
        console.log("[scheduled] Gmail purchase discovery", summary);
        const huntsDispatched = await dispatchImportHunts(
          db,
          env.PURCHASE_AGENT_QUEUE,
        );
        console.log("[scheduled] Purchase hunts dispatched", {
          huntsDispatched,
        });
        for (const failure of summary.failures) {
          Sentry.captureMessage(
            `Gmail purchase discovery failed for ${failure.ledgerPartyId}: ${failure.error}`,
            "warning",
          );
        }
      });
      return;
    }
    await withTrace(
      "cf.scheduled",
      async () => {
        try {
          await withTrace(
            "cf.scheduled.job",
            async () =>
              await (
                await calendarFeedStateFor(env.APP_ORIGIN)
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
        await withRequestDbClient(env.HYPERDRIVE.connectionString, async () => {
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
                  "cubby.awaiting.pending_uploads": awaiting.pendingUploads,
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
        });
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
                  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                  let cursor: SearchDocumentCursor | undefined;
                  let deletedCount = 0;
                  do {
                    const page = await selectRecentlySoftDeletedSearchRefs(db, {
                      since,
                      cursor,
                    });
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
        // second cron the day one is added, since this handler receives every
        // trigger on the worker.
        "cloudflare.cron": controller.cron,
      },
    );
  },
};

type PurchaseAgentCommand = {
  kind:
    | "navigate_orders"
    | "capture_order"
    | "capture_pdf"
    | "capture_screenshot"
    | "open_auth";
  target?: string;
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

  issueBrowserCommand(input: {
    runId: string;
    operationId: string;
    command: PurchaseAgentCommand;
  }) {
    return this.withDatabase(async (db, service) => {
      const scope = await service.loadRunScope(db, input.runId);
      if (!scope.public.vendorAccountId)
        throw new Error("This import run has no browser account");
      if (input.command.kind === "open_auth") {
        await this.env.PURCHASE_IMPORT.getByName(
          scope.public.vendorAccountId,
        ).requestAuthentication(input.runId);
        return { state: "paused_auth" };
      }
      const claimed = await service.claimNextImportWork(
        db,
        this.env.PURCHASE_IMPORT,
        input.runId,
      );
      const target =
        input.command.target ??
        ("startUrl" in claimed ? claimed.startUrl : null);
      const operation =
        input.command.kind === "navigate_orders"
          ? {
              type: "navigate" as const,
              url: target ?? "",
              allowedHosts: scope.public.allowedHosts,
            }
          : {
              type: "capture" as const,
              allowedHosts: scope.public.allowedHosts,
              enhancedEvidence:
                input.command.kind === "capture_pdf" ||
                input.command.kind === "capture_screenshot",
            };
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

  recordOrchestrationUsage(input: {
    runId: string;
    operationId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost: number;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "record_orchestration_usage", payload: input },
        () => service.recordOrchestrationUsage(db, input),
      ),
    );
  }

  markRunFailed(input: {
    runId: string;
    operationId: string;
    failureCode: "flue_failed" | "flue_aborted";
    detail?: string;
  }) {
    return this.withDatabase((db, service) =>
      service.runImportOperation(
        db,
        { ...input, kind: "mark_run_failed", payload: input },
        () => service.markImportRunFailed(db, input),
      ),
    );
  }
}

export { CalendarFeedDurableObject } from "./server/calendar/durable-object";
export { PurchaseImportDurableObject } from "./server/purchase-import/durable-object";
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
    // production reporting (SENTRY_ENVIRONMENT var stays "production" there;
    // only `preview:cf`'s local `wrangler dev` overrides it to "development")
    // because they access the production database.
    environment: resolveWorkerSentryEnvironment(env),
    // Keep the scrubber as defense in depth for manually attached request data,
    // even though the SDK no longer sends default PII.
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
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

export { DatabaseFreshnessDurableObject } from "./server/database-freshness/durable-object";
