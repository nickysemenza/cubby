import { AsyncLocalStorage } from "node:async_hooks";

import { createLogger, originalLoggedError } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/cloudflare";

import { isBrowserOperationPath } from "~/lib/browser-operation-path";
import { DOORBELL_PATH } from "~/lib/doorbell";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import {
  TELEMETRY_SCHEMA_VERSION,
  withHtmlNoCache,
  withResponseDiagnostics,
} from "~/lib/http-cache";
import { httpRouteTemplate } from "~/lib/http-route-template";
import { observeResponseBody } from "~/lib/response-body-observer";
import {
  readStartOperationTraceContext,
  startOperationTraceAttributes,
  startOperationTraceName,
} from "~/lib/start-operation-observability";
import { runWithExecutionCtx, withCfEnv } from "~/server/cf-env";
import { withRequestDb } from "~/server/db";
import {
  requestOperations,
  serverTimingHeader,
  withDatabaseRequestMetrics,
} from "~/server/db/db-observability";
import {
  reportServerError,
  withErrorReporting,
} from "~/server/errors/report-error";
import { withUnhandledErrorBody } from "~/server/errors/unhandled-error-body";
import {
  isMaintenanceMode,
  maintenanceResponse,
} from "~/server/http/maintenance";
import { classifyHttpWorkload } from "~/server/http/workload";
import {
  type AppSpan,
  getRequestId,
  withInvocationTrace,
  withManualTrace,
  withTrace,
} from "~/server/observability/tracing";
import { testDurationOverrideMs } from "~/server/testing/test-duration-override";

// A selected protocol's first evaluation is caught by the invocation failure
// policy. A rejected ESM evaluation stays failed; clearing a promise is not recovery.
function moduleLoader<T>(name: string, load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  let state = "uninitialized";
  return () =>
    withTrace(name, (span) => {
      span.setAttribute("cubby.module.import_state", state);
      pending ??= (() => {
        state = "pending";
        return load().then(
          (module) => {
            state = "ready";
            return module;
          },
          (error) => {
            state = "failed";
            throw error;
          },
        );
      })();
      return pending;
    });
}
const getHandler = moduleLoader(
  "cf.importHandler",
  () => import("@tanstack/react-start/server-entry"),
);
const getBrowserOperation = moduleLoader(
  "cf.importBrowserOperation",
  () => import("~/server/operation-runtime/browser-operation-dispatch"),
);

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

let fetchInvocationOrdinal = 0;

type HttpContext = { waitUntil(promise: Promise<unknown>): void };

async function invokeApplication(
  request: Request,
  url: URL,
): Promise<Response> {
  if (url.pathname === DOORBELL_PATH)
    return withTrace("cf.doorbell", async () =>
      (await import("~/server/http/doorbell")).handleDoorbellUpgrade(request),
    );
  if (isBrowserOperationPath(url.pathname)) {
    const module = await getBrowserOperation();
    return module.handleBrowserOperationDispatch(request);
  }
  const module = await getHandler();
  return module.default.fetch(request);
}

async function dispatchHttp(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (
    ["/.well-known/caldav", "/.well-known/caldav/", "/api/caldav"].includes(
      url.pathname,
    ) ||
    url.pathname.startsWith("/api/caldav/")
  )
    return withTrace("cf.caldav", async () =>
      (
        await import("~/server/domains/calendar/repo/client")
      ).handleCalDavRequest(request),
    );
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname.startsWith("/api/calendar/")
  )
    return withTrace("cf.calendarFeed", async () => {
      const [{ createCalendarFeedHandler }, calendar] = await Promise.all([
        import("~/server/domains/calendar/service/feed"),
        import("~/server/domains/calendar/repo/client"),
      ]);
      return createCalendarFeedHandler(calendar.externalCalendarFeedStateFor)({
        request,
      });
    });
  return withRequestDb(
    {
      strong: env.HYPERDRIVE.connectionString,
      boundedStale: env.HYPERDRIVE_CACHED.connectionString,
      poolIdleTimeoutMs: testDurationOverrideMs(
        env.CUBBY_TEST_POOL_IDLE_TIMEOUT_MS,
      ),
    },
    () => invokeApplication(request, url),
  );
}

async function finishResponse(
  response: Response,
  request: Request,
  env: Env,
  span: AppSpan,
  endSpan: () => void,
  handlerStartedAt: number,
  invocationOrdinal: number,
): Promise<Response> {
  span.setAttribute("http.response.status_code", response.status);
  // Reconstructing an upgrade drops workerd's non-standard WebSocket slot.
  if (response.status === 101) {
    endSpan();
    return response;
  }
  // Frameworks can return a 500 after logging instead of throwing.
  // Retain its original diagnostic without buffering healthy streams.
  const interceptedError = interceptedErrorStore.getStore()?.error;
  let fallbackEventId: string | undefined;
  if (response.status >= 500 && interceptedError) {
    log.error("Unhandled error:", {
      error: interceptedError,
    });
    fallbackEventId = reportServerError(interceptedError, {
      requestId: getRequestId(request.headers),
    });
  }

  const responsePreparationStartedAt = performance.now();
  const correlatedResponse = withResponseDiagnostics(
    withHtmlNoCache(
      response.status >= 500 && interceptedError
        ? await withUnhandledErrorBody(response, interceptedError)
        : response,
    ),
    {
      requestId: getRequestId(request.headers),
      workerVersion: env.CF_VERSION_METADATA.id,
    },
  );
  span.setAttribute(
    "cubby.response.prepare.duration_ms",
    Math.round(performance.now() - responsePreparationStartedAt),
  );
  if (fallbackEventId)
    correlatedResponse.headers.set("x-sentry-event-id", fallbackEventId);
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
  return observeResponseBody(correlatedResponse, (observation) => {
    if (operations.length > 0)
      span.setAttribute("cubby.operations", operations.join(" "));
    span.setAttributes({
      "cubby.response.body.outcome": observation.outcome,
      "cubby.response.stream.duration_ms": Math.round(observation.durationMs),
      "cubby.response.cancelled": observation.outcome === "cancelled",
    });
    if (observation.outcome === "error") {
      span.setError("response_stream_error");
    }
    endSpan();
  });
}

/** Owns HTTP routing and body lifetime; the platform entry only adapts events. */
export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: HttpContext,
): Promise<Response> {
  const startedAt = performance.now();
  const invocationOrdinal = ++fetchInvocationOrdinal;
  const url = new URL(request.url);
  const ray = request.headers.get("cf-ray") ?? undefined;
  const startTraceContext = url.pathname.startsWith("/_serverFn/")
    ? readStartOperationTraceContext(request.headers)
    : undefined;
  const routeTemplate = httpRouteTemplate(url.pathname, {
    serverFunction: startTraceContext !== undefined,
  });
  return withCfEnv(env, () =>
    runWithExecutionCtx(
      ctx,
      () =>
        withInvocationTrace(
          "cf.app.entry",
          (entrySpan) =>
            withDatabaseRequestMetrics(entrySpan, async () => {
              Sentry.setTag("request_id", ray);
              const readyResponse = await withErrorReporting(async () => {
                try {
                  if (isMaintenanceMode(env))
                    return withResponseDiagnostics(
                      maintenanceResponse(request),
                      {
                        requestId: getRequestId(request.headers),
                        workerVersion: env.CF_VERSION_METADATA.id,
                      },
                    );
                  return await interceptedErrorStore.run({ error: null }, () =>
                    withManualTrace(
                      startTraceContext
                        ? `cf.fetch.${startOperationTraceName(startTraceContext)}`
                        : "cf.fetch",
                      async (span, endSpan) => {
                        const handlerStartedAt = performance.now();
                        const response = await withTrace("cf.handler", () =>
                          dispatchHttp(request, env, url),
                        );
                        return finishResponse(
                          response,
                          request,
                          env,
                          span,
                          endSpan,
                          handlerStartedAt,
                          invocationOrdinal,
                        );
                      },
                      {
                        "http.request.method": request.method,
                        "http.route": routeTemplate,
                        "server.address": url.hostname,
                        "service.version": env.CF_VERSION_METADATA.id,
                        "cloudflare.worker.version.tag":
                          env.CF_VERSION_METADATA.tag,
                        "cloudflare.worker.version.timestamp":
                          env.CF_VERSION_METADATA.timestamp,
                        "cubby.telemetry.schema_version":
                          TELEMETRY_SCHEMA_VERSION,
                        "cubby.workload": classifyHttpWorkload(
                          url.pathname,
                          request.headers,
                        ),
                        "cloudflare.ray_id": ray,
                        ...startOperationTraceAttributes(startTraceContext),
                      },
                    ),
                  );
                } catch (error) {
                  const eventId = reportServerError(error, {
                    requestId: getRequestId(request.headers),
                  });
                  log.error("Worker request failed", { error });
                  const detail =
                    error instanceof Error
                      ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
                      : String(error);
                  const response = withResponseDiagnostics(
                    new Response(scrubErrorMessage(detail), {
                      status: 500,
                      headers: {
                        "cache-control": "no-store",
                        "content-type": "text/plain; charset=utf-8",
                      },
                    }),
                    {
                      requestId: getRequestId(request.headers),
                      workerVersion: env.CF_VERSION_METADATA.id,
                    },
                  );
                  if (eventId)
                    response.headers.set("x-sentry-event-id", eventId);
                  return response;
                }
              }, request.headers);
              entrySpan.setAttributes({
                "http.response.status_code": readyResponse.status,
                "cubby.response.ready.duration_ms": Math.round(
                  performance.now() - startedAt,
                ),
              });
              return readyResponse;
            }),
          {
            "http.request.method": request.method,
            "http.route": routeTemplate,
            "cubby.worker.invocation_ordinal": invocationOrdinal,
            "cubby.worker.first_invocation": invocationOrdinal === 1,
            "cloudflare.ray_id": ray,
            "service.version": env.CF_VERSION_METADATA.id,
            "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
            "cubby.workload": classifyHttpWorkload(
              url.pathname,
              request.headers,
            ),
          },
        ),
      url.origin,
    ),
  );
}
