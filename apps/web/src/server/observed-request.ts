import { type JSONType, z } from "zod";

import type {
  ProductDetailPhase,
  StartOperationDefinition,
} from "~/lib/start-operation-observability";
import {
  type DatabaseOperationMetrics,
  withDatabaseOperationMetrics,
} from "~/server/db-observability";
import { isExpectedAppError } from "~/server/errors/app-error";
import { reportServerError } from "~/server/errors/report-error";
import { type AppSpan, withTrace } from "~/server/tracing";
import type { RequestOrigin, Workload } from "~/server/workload";

export type ObservedFailure = Error | JSONType;
export type ObservedResult = {
  error?: ObservedFailure;
  workload?: Workload;
  reported?: boolean;
};

export type OperationObservation<Result> = {
  origin: RequestOrigin;
  workload: Workload;
  inspectResult?: (result: Result) => ObservedResult;
};

export function parseObservedFailure<TError>(error: TError): ObservedFailure {
  if (error instanceof Error) return error;
  try {
    const serializable = z.json().safeParse(error);
    if (serializable.success) return serializable.data;
  } catch {
    // SILENT: cycles and throwing getters must not replace the failure being
    // observed; the fallback `Error` wrapper below still carries the
    // original `error` as `cause`.
  }
  return new Error("A non-serializable value was thrown", { cause: error });
}

const databaseMetricAttributes = (metrics: DatabaseOperationMetrics) => ({
  "db.query.count": metrics.queryCount,
  "db.query.duration_sum_ms": Math.round(metrics.queryDurationSumMs),
  "db.query.active_wall_ms": Math.round(metrics.queryActiveWallMs),
  "db.query.max_duration_ms": Math.round(metrics.queryMaxDurationMs),
  "db.query.max_concurrency": metrics.queryMaxConcurrency,
  "db.acquire.count": metrics.acquireCount,
  "db.acquire.duration_sum_ms": Math.round(metrics.acquireDurationSumMs),
  "db.acquire.active_wall_ms": Math.round(metrics.acquireActiveWallMs),
  "db.acquire.max_duration_ms": Math.round(metrics.acquireMaxDurationMs),
  "db.acquire.max_concurrency": metrics.acquireMaxConcurrency,
});

export function isObservedCancellation<TError>(error: TError): boolean {
  const failure = parseObservedFailure(error);
  return (
    (failure instanceof DOMException && failure.name === "AbortError") ||
    (failure instanceof Error &&
      (failure.name === "AbortError" || failure.name === "CancelledError"))
  );
}

async function observeRequest<T>(options: {
  system: "start";
  method: string;
  type: "query" | "mutation" | "subscription";
  origin: RequestOrigin;
  workload: Workload;
  run: (span: AppSpan) => Promise<T>;
  inspectResult?: (result: T) => ObservedResult;
}): Promise<T> {
  const traceName = `${options.system}.${options.type}.${options.method}`;
  return await withTrace(traceName, async (span) => {
    return await withDatabaseOperationMetrics(async (dbMetrics) => {
      span.setAttributes({
        "rpc.system": options.system,
        "rpc.method": options.method,
        "rpc.type": options.type,
        "cubby.request_origin": options.origin,
        "cubby.workload": options.workload,
      });
      try {
        const result = await options.run(span);
        const inspection = options.inspectResult?.(result);
        if (inspection?.workload) {
          span.setAttribute("cubby.workload", inspection.workload);
        }
        if (inspection?.error) {
          if (isObservedCancellation(inspection.error)) {
            span.setAttribute("cubby.cancelled", true);
            return result;
          }
          span.recordException(inspection.error);
          span.setError();
          if (!inspection.reported && !isExpectedAppError(inspection.error)) {
            reportServerError(inspection.error, { operation: options.method });
          }
        }
        return result;
      } catch (error) {
        const failure = parseObservedFailure(error);
        if (isObservedCancellation(failure)) {
          span.setAttribute("cubby.cancelled", true);
          throw error;
        }
        if (!isExpectedAppError(failure)) {
          reportServerError(error, { operation: options.method });
        }
        throw error;
      } finally {
        span.setAttributes(databaseMetricAttributes(dbMetrics));
      }
    });
  });
}

export function observeOperation<T>(
  definition: StartOperationDefinition,
  context: OperationObservation<T>,
  run: (span: AppSpan) => Promise<T>,
): Promise<T> {
  return observeRequest({
    system: "start",
    method: definition.id,
    type: definition.kind,
    ...context,
    run,
  });
}

export async function observeOperationPhase<T>(
  definition: StartOperationDefinition,
  phase: ProductDetailPhase,
  run: () => Promise<T>,
): Promise<T> {
  if (!definition.productPhases.includes(phase)) {
    throw new Error(`${phase} is not registered for ${definition.id}`);
  }
  const startedAt = performance.now();
  return withTrace(`product.detail.${phase}`, async (span) =>
    withDatabaseOperationMetrics(async (metrics) => {
      try {
        return await run();
      } finally {
        span.setAttributes({
          "cubby.phase": phase,
          "cubby.phase.duration_ms": Math.round(performance.now() - startedAt),
          ...databaseMetricAttributes(metrics),
        });
      }
    }),
  );
}
