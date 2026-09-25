import pg from "pg";
import { afterAll, afterEach, vi } from "vitest";
import { closeTestDb } from "./test-setup";

declare global {
  // Process-wide: `isolate: false` reruns this setup file per test file, but
  // the pg prototype is patched once, so the list must outlive each run.
  var cubbyPgConcurrentQueries: Error[] | undefined;
}

/**
 * pg 8 queues a query sent to a client that already has one waiting and warns
 * once per process; pg 9 rejects it. Production clients serialize their own
 * queries (`db-pg-tracing.ts`), so this fails any test whose connection skips
 * that wrapper, with the caller's stack rather than a one-time warning.
 */
/** pg's private queue state, read only to mirror its own deprecation check. */
interface PgQueueState {
  _queryQueue: readonly unknown[];
  pipeline?: boolean;
}
type PgQuery = (
  this: pg.Client,
  ...args: never[]
) => Promise<pg.QueryResult> | pg.Submittable | void;

if (!globalThis.cubbyPgConcurrentQueries) {
  const concurrentQueries: Error[] = [];
  globalThis.cubbyPgConcurrentQueries = concurrentQueries;
  const query: PgQuery = pg.Client.prototype.query;
  function guardedQuery(this: pg.Client & PgQueueState, ...args: never[]) {
    if (this._queryQueue.length > 0 && !this.pipeline) {
      // Drizzle and tracing frames fill the default 10 before the caller's.
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      concurrentQueries.push(
        new Error("Concurrent query on one pg client (pg@9 rejects this)"),
      );
      Error.stackTraceLimit = limit;
    }
    return query.apply(this, args);
  }
  // SAFETY: guardedQuery forwards every overload's arguments unchanged to pg's
  // own query, so it returns whatever that overload returns.
  pg.Client.prototype.query = guardedQuery as typeof pg.Client.prototype.query;
}

afterEach(() => {
  const [first] = globalThis.cubbyPgConcurrentQueries?.splice(0) ?? [];
  if (first) throw first;
});

/**
 * File-level teardown for the integration project (a vitest `setupFiles`
 * entry, so this `afterAll` is scoped to the whole test file).
 *
 * `withTestDb()` caches one IntegreSQL database per file; this hands it back
 * when the file finishes. Registering it here rather than inside `withTestDb()`
 * is what makes it file-scoped — see `closeTestDb`.
 */
afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
