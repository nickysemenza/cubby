import { drizzle } from "drizzle-orm/node-postgres";
import pg, { type Pool } from "pg";
import { afterAll, afterEach, vi } from "vitest";
import type { DatabaseRuntime } from "../src/server/db/database-runtime";
import * as schema from "../src/server/db/schema";
import { createPostgresPool } from "./postgres-pool";
import { closeTestDb } from "./test-setup";

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
 * `~/server/db`'s module runtime, on a pool the per-test reset owns. The
 * workerd harness points E2E_DATABASE_URL at this file's database, so
 * in-process code that loads `db.ts` afterwards connects there (Better Auth
 * seeds its OAuth resource on import); a plain module pool would leave an idle
 * session the reset refuses to evict. Connects lazily, where `db.ts` would.
 */
let modulePool: Pool | undefined;
let moduleClient: DatabaseRuntime["client"] | undefined;
const connectModulePool = () => {
  if (modulePool) return modulePool;
  modulePool = createPostgresPool({
    connectionString: process.env.E2E_DATABASE_URL || process.env.DATABASE_URL,
    max: 25,
  });
  // The reset's termination surfaces on the idle client; the pool reconnects.
  modulePool.on("error", () => {});
  return modulePool;
};
const moduleRuntime: DatabaseRuntime = {
  get client() {
    return (moduleClient ??= drizzle({ client: connectModulePool(), schema }));
  },
  withConnection: async (fn) => {
    const connection = await connectModulePool().connect();
    try {
      return await fn(drizzle({ client: connection, schema }));
    } finally {
      connection.release();
    }
  },
};
// Replaced per file: `db.ts` reads this global when each file's graph loads.
Object.assign(globalThis, {
  [Symbol.for("cubby.database.runtime")]: moduleRuntime,
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
  await modulePool?.end();
  await closeTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
