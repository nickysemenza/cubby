import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseOperationMetrics = {
  queryCount: number;
  /** @deprecated Use queryDurationSumMs; retained while span consumers migrate. */
  queryDurationMs: number;
  queryDurationSumMs: number;
  queryActiveWallMs: number;
  queryMaxDurationMs: number;
  queryMaxConcurrency: number;
  acquireCount: number;
  /** @deprecated Use acquireDurationSumMs; retained while span consumers migrate. */
  acquireDurationMs: number;
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
  activity: {
    query: ActivityState;
    acquire: ActivityState;
  };
};

const operationMetricsStore = new AsyncLocalStorage<
  StoredDatabaseOperationMetrics[]
>();

const emptyMetrics = (): StoredDatabaseOperationMetrics => ({
  queryCount: 0,
  queryDurationMs: 0,
  queryDurationSumMs: 0,
  queryActiveWallMs: 0,
  queryMaxDurationMs: 0,
  queryMaxConcurrency: 0,
  acquireCount: 0,
  acquireDurationMs: 0,
  acquireDurationSumMs: 0,
  acquireActiveWallMs: 0,
  acquireMaxDurationMs: 0,
  acquireMaxConcurrency: 0,
  activity: {
    query: { activeCount: 0 },
    acquire: { activeCount: 0 },
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

type ActivityKind = "query" | "acquire";
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

    if (kind === "query") {
      metrics.queryMaxConcurrency = Math.max(
        metrics.queryMaxConcurrency,
        activity.activeCount,
      );
    } else {
      metrics.acquireMaxConcurrency = Math.max(
        metrics.acquireMaxConcurrency,
        activity.activeCount,
      );
    }
  }

  let finished = false;
  return (endedAt = performance.now()) => {
    if (finished) return;
    finished = true;

    const durationMs = Math.max(0, endedAt - startedAt);
    for (const metrics of collectors) {
      const activity = metrics.activity[kind];
      if (kind === "query") {
        metrics.queryCount += 1;
        metrics.queryDurationMs += durationMs;
        metrics.queryDurationSumMs += durationMs;
        metrics.queryMaxDurationMs = Math.max(
          metrics.queryMaxDurationMs,
          durationMs,
        );
      } else {
        metrics.acquireCount += 1;
        metrics.acquireDurationMs += durationMs;
        metrics.acquireDurationSumMs += durationMs;
        metrics.acquireMaxDurationMs = Math.max(
          metrics.acquireMaxDurationMs,
          durationMs,
        );
      }

      activity.activeCount -= 1;
      if (activity.activeCount !== 0) continue;

      const activeStartedAt = activity.activeStartedAt ?? startedAt;
      const activeWallMs = Math.max(0, endedAt - activeStartedAt);
      activity.activeStartedAt = undefined;
      if (kind === "query") metrics.queryActiveWallMs += activeWallMs;
      else metrics.acquireActiveWallMs += activeWallMs;
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
