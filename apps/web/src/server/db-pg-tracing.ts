import pg from "pg";

import { databaseStatementForTrace } from "~/lib/db-query-telemetry";

import { beginDatabaseAcquire, beginDatabaseQuery } from "./db-observability";
import { TraceNames, withTrace } from "./tracing";

export type RequestDbRole = "strong" | "bounded-stale";

const DB_SYSTEM = "postgresql";
const DB_NAMESPACE = "cubby";

const extractOperation = (sql: string): string | undefined =>
  /^\s*(\w+)/u.exec(sql)?.[1]?.toUpperCase();

type QueryHead = string | pg.QueryConfig | pg.QueryArrayConfig | pg.Submittable;
type QueryCallback = (
  error: Error,
  result: pg.QueryResult | pg.QueryArrayResult,
) => void;
type QueryValues = NonNullable<pg.QueryConfig["values"]>;
type PromiseQueryArguments =
  | [query: string | pg.QueryConfig | pg.QueryArrayConfig]
  | [query: string | pg.QueryConfig | pg.QueryArrayConfig, values: QueryValues];
type CallbackQueryArguments =
  | [
      query: string | pg.QueryConfig | pg.QueryArrayConfig,
      callback: QueryCallback,
    ]
  | [query: string, values: QueryValues, callback: QueryCallback];
type StreamQueryArguments = [query: pg.Submittable];
type QueryArguments =
  | PromiseQueryArguments
  | CallbackQueryArguments
  | StreamQueryArguments;
type QueryResponse = pg.QueryResult | pg.QueryArrayResult;
export type PgQueryImplementation = (
  ...args: QueryArguments
) => Promise<QueryResponse> | pg.Submittable | void;
type QueryBridge = pg.Pool["query"] & {
  (...args: PromiseQueryArguments): Promise<QueryResponse>;
  (...args: CallbackQueryArguments): void;
  (...args: StreamQueryArguments): pg.Submittable;
};

type PoolConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  release: (releaseError?: Error | boolean) => void,
) => void;
type PoolConnectArguments = [] | [callback: PoolConnectCallback];
export type PgPoolConnectImplementation = (
  ...args: PoolConnectArguments
) => Promise<pg.PoolClient> | void;
type PoolConnectBridge = pg.Pool["connect"] & PgPoolConnectImplementation;

/**
 * `pg` publishes query/connect as overload sets, but JavaScript adapters
 * implement each set with one rest-argument function. TypeScript cannot prove
 * that equivalence from a union of the complete runtime tuples.
 */
const preservePgOverloads = <PublicSignature, RuntimeSignature>(
  implementation: RuntimeSignature,
): PublicSignature & RuntimeSignature => {
  // SAFETY: RuntimeSignature enumerates every pg promise, callback, and stream
  // tuple accepted by PublicSignature, and each adapter preserves the matching
  // return mode before this single overload restoration boundary.
  return implementation as PublicSignature & RuntimeSignature;
};

const queryBridge = (
  implementation: PgQueryImplementation | pg.Pool["query"],
): QueryBridge =>
  preservePgOverloads<QueryBridge, typeof implementation>(implementation);

const connectBridge = (
  implementation: PgPoolConnectImplementation | pg.Pool["connect"],
): PoolConnectBridge =>
  preservePgOverloads<PoolConnectBridge, typeof implementation>(implementation);

const queryImplementationFor =
  (run: QueryBridge): PgQueryImplementation =>
  (...args) => {
    if (isCallbackQuery(args)) return run(...args);
    if (isStreamQuery(args)) return run(...args);
    return run(...args);
  };

const isQueryCallback = (
  value: QueryHead | QueryValues | QueryCallback | undefined,
): value is QueryCallback => typeof value === "function";

const isSubmittable = (value: QueryHead): value is pg.Submittable =>
  typeof value !== "string" && "submit" in value;

const isCallbackQuery = (
  args: QueryArguments,
): args is CallbackQueryArguments => isQueryCallback(args.at(-1));

const isStreamQuery = (args: QueryArguments): args is StreamQueryArguments =>
  args.length === 1 && isSubmittable(args[0]);

const observableStatement = (head: QueryHead): string | undefined =>
  isSubmittable(head) ? undefined : databaseStatementForTrace(head);

const observedQuery = (
  run: QueryBridge,
  observe: (statement: string) => void,
): QueryBridge => {
  const implementation: PgQueryImplementation = (...args) => {
    const statement = observableStatement(args[0]);
    if (statement !== undefined) observe(statement);
    if (isCallbackQuery(args)) return run(...args);
    if (isStreamQuery(args)) return run(...args);
    return run(...args);
  };
  return queryBridge(implementation);
};

/** Testable observation contract before pg overload restoration. */
export const createObservedQuery = (
  run: PgQueryImplementation,
  observe: (statement: string) => void,
): PgQueryImplementation =>
  queryImplementationFor(observedQuery(queryBridge(run), observe));

/** Instrument one pg client without reproducing its overload restoration. */
export const observePgClientQueries = <T extends pg.PoolClient>(
  client: T,
  observe: (statement: string) => void,
): T => {
  client.query = observedQuery(queryBridge(client.query.bind(client)), observe);
  return client;
};

/** Map every callback- or promise-acquired client from one pg pool. */
export const mapPgPoolClients = (
  pool: pg.Pool,
  mapClient: (client: pg.PoolClient) => pg.PoolClient,
): pg.Pool => {
  const rawConnect = connectBridge(pool.connect.bind(pool));
  const implementation: PgPoolConnectImplementation = (...args) => {
    const callback = args[0];
    if (callback) {
      return rawConnect((error, client, release) =>
        callback(error, client ? mapClient(client) : client, release),
      );
    }
    return rawConnect().then(mapClient);
  };
  pool.connect = connectBridge(implementation);
  return pool;
};

const traceQuery = (
  run: QueryBridge,
  getTransaction: () => boolean,
  role: RequestDbRole,
): QueryBridge => {
  const implementation: PgQueryImplementation = (...args) => {
    if (isCallbackQuery(args)) return run(...args);
    if (isStreamQuery(args)) return run(...args);

    const sql = databaseStatementForTrace(args[0]);
    const operation = extractOperation(sql);
    const execute = () =>
      withTrace(TraceNames.db(operation ?? "query"), async (span) => {
        if (span.isRecording) {
          span.setAttributes({
            "db.system.name": DB_SYSTEM,
            "db.namespace": DB_NAMESPACE,
            "db.operation.name": operation,
            "db.query.text": sql,
            "db.query.transaction": getTransaction(),
            "cubby.db.binding_role": role,
          });
        }
        const finishQuery = beginDatabaseQuery();
        try {
          const response = await run(...args);
          span.setAttribute(
            "db.response.returned_rows",
            response.rowCount ?? response.rows.length,
          );
          return response;
        } finally {
          finishQuery();
        }
      });
    return execute();
  };
  return queryBridge(implementation);
};

/** Testable promise/callback tracing contract before pg overload restoration. */
export const createTracedQuery = (
  run: PgQueryImplementation,
  getTransaction: () => boolean,
  role: RequestDbRole,
): PgQueryImplementation =>
  queryImplementationFor(traceQuery(queryBridge(run), getTransaction, role));

export interface AcquiredPgQueryClient {
  query(...args: PromiseQueryArguments): Promise<QueryResponse>;
  release(): void;
}

export const createPoolQueryAdapter =
  (
    rawQuery: PgQueryImplementation,
    acquire: (inTransaction: boolean) => Promise<AcquiredPgQueryClient>,
  ): PgQueryImplementation =>
  (...args) => {
    if (isCallbackQuery(args)) return rawQuery(...args);
    if (isStreamQuery(args)) return rawQuery(...args);
    return acquire(false).then(async (client) => {
      try {
        return await client.query(...args);
      } finally {
        client.release();
      }
    });
  };

export const createPoolConnectAdapter =
  (
    rawConnect: PgPoolConnectImplementation,
    acquire: (inTransaction: boolean) => Promise<pg.PoolClient>,
  ): PgPoolConnectImplementation =>
  (...args) => {
    const callback = args[0];
    if (callback) return rawConnect(callback);
    return acquire(true);
  };

const transactionState = new WeakMap<pg.ClientBase, boolean>();
const tracedClients = new WeakSet<pg.ClientBase>();
const poolAcquirers = new WeakMap<
  pg.Pool,
  (inTransaction: boolean) => Promise<pg.PoolClient>
>();

const traceClient = <T extends pg.ClientBase>(
  client: T,
  role: RequestDbRole,
): T => {
  if (tracedClients.has(client)) return client;
  const rawQuery = queryBridge(client.query.bind(client));
  client.query = traceQuery(
    rawQuery,
    () => transactionState.get(client) ?? false,
    role,
  );
  tracedClients.add(client);
  return client;
};

export const tracePool = (pool: pg.Pool, role: RequestDbRole): pg.Pool => {
  const rawQuery = queryBridge(pool.query.bind(pool));
  const rawConnect = connectBridge(pool.connect.bind(pool));

  const acquire = (inTransaction: boolean): Promise<pg.PoolClient> =>
    withTrace(TraceNames.db("acquire"), async (span) => {
      span.setAttribute("db.acquire.transaction", inTransaction);
      const startedAt = performance.now();
      const finishAcquire = beginDatabaseAcquire(startedAt);
      try {
        const client = await rawConnect();
        const durationMs = Math.round(performance.now() - startedAt);
        span.setAttribute("db.acquire.duration_ms", durationMs);
        if (durationMs > 500) {
          console.warn(
            `[db-acquire] transaction=${inTransaction} duration_ms=${durationMs}`,
          );
        }
        transactionState.set(client, inTransaction);
        return traceClient(client, role);
      } finally {
        finishAcquire();
      }
    });

  const queryImplementation = createPoolQueryAdapter(
    queryImplementationFor(rawQuery),
    async (inTransaction) => {
      const client = await acquire(inTransaction);
      return {
        query: queryBridge(client.query.bind(client)),
        release: () => client.release(),
      };
    },
  );
  pool.query = queryBridge(queryImplementation);

  const connectImplementation = createPoolConnectAdapter(rawConnect, acquire);
  pool.connect = connectBridge(connectImplementation);
  poolAcquirers.set(pool, acquire);
  return pool;
};

export const traceStandaloneClient = (
  client: pg.Client,
  role: RequestDbRole,
): pg.Client => {
  transactionState.set(client, false);
  return traceClient(client, role);
};

export const acquireTracedConnection = (
  pool: pg.Pool,
  inTransaction: boolean,
): Promise<pg.PoolClient> => {
  const acquire = poolAcquirers.get(pool);
  return acquire ? acquire(inTransaction) : pool.connect();
};
