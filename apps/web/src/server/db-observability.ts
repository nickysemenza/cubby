import { AsyncLocalStorage } from "node:async_hooks";

import type { AppSpan } from "./tracing";

export type DatabaseOperationMetrics = {
  queryCount: number;
  queryDurationSumMs: number;
  queryActiveWallMs: number;
  queryMaxDurationMs: number;
  queryMaxConcurrency: number;
  clientQueueCount: number;
  clientQueueDurationSumMs: number;
  clientQueueActiveWallMs: number;
  clientQueueMaxDurationMs: number;
  clientQueueMaxConcurrency: number;
  acquireCount: number;
  acquireDurationSumMs: number;
  acquireActiveWallMs: number;
  acquireMaxDurationMs: number;
  acquireMaxConcurrency: number;
};

type ActivityState = {
  activeCount: number;
  activeStartedAt?: number;
};

type StoredDatabaseOperationMetrics = DatabaseOperationMetrics & {
  acquireStartedCount: number;
  /** Operations the request ran, for `Server-Timing`; request collector only. */
  operations: string[];
  activity: {
    query: ActivityState;
    acquire: ActivityState;
    clientQueue: ActivityState;
  };
};

const operationMetricsStore = new AsyncLocalStorage<
  StoredDatabaseOperationMetrics[]
>();

const emptyMetrics = (): StoredDatabaseOperationMetrics => ({
  acquireStartedCount: 0,
  operations: [],
  queryCount: 0,
  queryDurationSumMs: 0,
  queryActiveWallMs: 0,
  queryMaxDurationMs: 0,
  queryMaxConcurrency: 0,
  clientQueueCount: 0,
  clientQueueDurationSumMs: 0,
  clientQueueActiveWallMs: 0,
  clientQueueMaxDurationMs: 0,
  clientQueueMaxConcurrency: 0,
  acquireCount: 0,
  acquireDurationSumMs: 0,
  acquireActiveWallMs: 0,
  acquireMaxDurationMs: 0,
  acquireMaxConcurrency: 0,
  activity: {
    query: { activeCount: 0 },
    acquire: { activeCount: 0 },
    clientQueue: { activeCount: 0 },
  },
});

/**
 * Collect a request operation's database work without turning an unbounded
 * list of statement spans into its primary dashboard dimension.
 */
export const withDatabaseOperationMetrics = async <T>(
  fn: (metrics: DatabaseOperationMetrics) => Promise<T>,
): Promise<T> => {
  const metrics = emptyMetrics();
  const collectors = [...(operationMetricsStore.getStore() ?? []), metrics];
  return operationMetricsStore.run(collectors, () => fn(metrics));
};

type ActivityKind = "query" | "acquire" | "clientQueue";
type FinishActivity = (endedAt?: number) => void;

const beginDatabaseActivity = (
  kind: ActivityKind,
  startedAt: number,
): FinishActivity => {
  const collectors = operationMetricsStore.getStore();
  if (!collectors?.length) return () => undefined;

  for (const metrics of collectors) {
    const activity = metrics.activity[kind];
    activity.activeCount += 1;
    if (activity.activeCount === 1) activity.activeStartedAt = startedAt;

    const maxConcurrency = `${kind}MaxConcurrency` as const;
    metrics[maxConcurrency] = Math.max(
      metrics[maxConcurrency],
      activity.activeCount,
    );
  }

  let finished = false;
  return (endedAt = performance.now()) => {
    if (finished) return;
    finished = true;

    const durationMs = Math.max(0, endedAt - startedAt);
    for (const metrics of collectors) {
      const activity = metrics.activity[kind];
      const count = `${kind}Count` as const;
      const durationSum = `${kind}DurationSumMs` as const;
      const maxDuration = `${kind}MaxDurationMs` as const;
      metrics[count] += 1;
      metrics[durationSum] += durationMs;
      metrics[maxDuration] = Math.max(metrics[maxDuration], durationMs);

      activity.activeCount -= 1;
      if (activity.activeCount !== 0) continue;

      const activeStartedAt = activity.activeStartedAt ?? startedAt;
      const activeWallMs = Math.max(0, endedAt - activeStartedAt);
      activity.activeStartedAt = undefined;
      const activeWall = `${kind}ActiveWallMs` as const;
      metrics[activeWall] += activeWallMs;
    }
  };
};

/** Start one query interval. The returned idempotent callback closes it. */
export const beginDatabaseQuery = (
  startedAt = performance.now(),
): FinishActivity => beginDatabaseActivity("query", startedAt);

/** Start one pool-acquisition interval. The returned callback closes it. */
export const beginDatabaseAcquire = (
  startedAt = performance.now(),
): FinishActivity => beginDatabaseActivity("acquire", startedAt);

/** Client-side serialization is distinct from pool acquire and SQL execution. */
export const beginDatabaseClientQueue = (
  startedAt = performance.now(),
): FinishActivity => beginDatabaseActivity("clientQueue", startedAt);

export const databaseMetricAttributes = (
  metrics: DatabaseOperationMetrics,
) => ({
  "db.query.count": metrics.queryCount,
  "db.query.duration_sum_ms": Math.round(metrics.queryDurationSumMs),
  "db.query.active_wall_ms": Math.round(metrics.queryActiveWallMs),
  "db.query.max_duration_ms": Math.round(metrics.queryMaxDurationMs),
  "db.query.max_concurrency": metrics.queryMaxConcurrency,
  "db.client_queue.count": metrics.clientQueueCount,
  "db.client_queue.duration_sum_ms": Math.round(
    metrics.clientQueueDurationSumMs,
  ),
  "db.client_queue.active_wall_ms": Math.round(metrics.clientQueueActiveWallMs),
  "db.client_queue.max_duration_ms": Math.round(
    metrics.clientQueueMaxDurationMs,
  ),
  "db.client_queue.max_concurrency": metrics.clientQueueMaxConcurrency,
  "db.acquire.count": metrics.acquireCount,
  "db.acquire.duration_sum_ms": Math.round(metrics.acquireDurationSumMs),
  "db.acquire.active_wall_ms": Math.round(metrics.acquireActiveWallMs),
  "db.acquire.max_duration_ms": Math.round(metrics.acquireMaxDurationMs),
  "db.acquire.max_concurrency": metrics.acquireMaxConcurrency,
});

/** Collect actual activity, not nested summaries, across the request boundary. */
export const withDatabaseRequestMetrics = <T>(
  span: Pick<AppSpan, "setAttributes">,
  run: () => Promise<T>,
): Promise<T> =>
  withDatabaseOperationMetrics(async (metrics) => {
    try {
      return await run();
    } finally {
      span.setAttributes(databaseMetricAttributes(metrics));
    }
  });

/** Name an operation this request ran, so `Server-Timing` can say which. */
export const noteRequestOperation = (
  operation: string,
  entity?: string,
): void => {
  operationMetricsStore
    .getStore()?.[0]
    ?.operations.push(entity ? `${operation}:${entity}` : operation);
};

/**
 * The live list of operations this request has run. A streamed batch keeps
 * appending after the handler returns, so read it when the body completes.
 */
export const requestOperations = (): readonly string[] =>
  operationMetricsStore.getStore()?.[0]?.operations ?? [];

/** Request order stays shared across binding pools and nested collectors. */
export const nextDatabaseAcquireOrdinal = (): number | undefined => {
  const request = operationMetricsStore.getStore()?.[0];
  return request ? ++request.acquireStartedCount : undefined;
};

/**
 * `Server-Timing` value for the request collector, so a browser can read the
 * DB split without trace access. Workers clocks only advance across I/O, so
 * these durations exclude synchronous CPU (render, parse); `handler` is the
 * same clock and must not be read as total server time.
 */
export const serverTimingHeader = (
  handlerMs: number,
  invocationOrdinal: number,
): string => {
  const metrics = operationMetricsStore.getStore()?.[0];
  const entries = [`handler;dur=${Math.round(handlerMs)}`];
  if (metrics) {
    entries.push(
      `db-acquire;dur=${Math.round(metrics.acquireActiveWallMs)};desc="n=${metrics.acquireCount} max=${Math.round(metrics.acquireMaxDurationMs)} conc=${metrics.acquireMaxConcurrency}"`,
      `db-query;dur=${Math.round(metrics.queryActiveWallMs)};desc="n=${metrics.queryCount} max=${Math.round(metrics.queryMaxDurationMs)} conc=${metrics.queryMaxConcurrency}"`,
      `db-queue;dur=${Math.round(metrics.clientQueueActiveWallMs)}`,
    );
  }
  if (metrics?.operations.length)
    entries.push(`op;desc="${metrics.operations.join(" ")}"`);
  entries.push(`invocation;desc="${invocationOrdinal}"`);
  return entries.join(", ");
};
