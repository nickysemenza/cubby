import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseOperationMetrics = {
  queryCount: number;
  queryDurationMs: number;
  queryMaxDurationMs: number;
  acquireCount: number;
  acquireDurationMs: number;
};

const operationMetricsStore = new AsyncLocalStorage<DatabaseOperationMetrics>();

const emptyMetrics = (): DatabaseOperationMetrics => ({
  queryCount: 0,
  queryDurationMs: 0,
  queryMaxDurationMs: 0,
  acquireCount: 0,
  acquireDurationMs: 0,
});

/**
 * Collect a request operation's database work without turning an unbounded
 * list of statement spans into its primary dashboard dimension.
 */
export const withDatabaseOperationMetrics = async <T>(
  fn: (metrics: DatabaseOperationMetrics) => Promise<T>,
): Promise<T> => {
  const metrics = emptyMetrics();
  return operationMetricsStore.run(metrics, () => fn(metrics));
};

export const recordDatabaseQuery = (durationMs: number): void => {
  const metrics = operationMetricsStore.getStore();
  if (!metrics) return;
  metrics.queryCount += 1;
  metrics.queryDurationMs += durationMs;
  metrics.queryMaxDurationMs = Math.max(metrics.queryMaxDurationMs, durationMs);
};

export const recordDatabaseAcquire = (durationMs: number): void => {
  const metrics = operationMetricsStore.getStore();
  if (!metrics) return;
  metrics.acquireCount += 1;
  metrics.acquireDurationMs += durationMs;
};
