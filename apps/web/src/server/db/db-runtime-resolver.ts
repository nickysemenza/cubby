import type { DatabaseRuntime } from "./database-runtime";
import type { RequestDbRole } from "./db-pg-tracing";

/**
 * Sockets one Worker request may open, inside the Worker connection ceiling:
 * five strong plus one bounded-stale, six total.
 */
const WORKER_REQUEST_CONNECTIONS = {
  strong: 5,
  "bounded-stale": 1,
} as const satisfies Record<RequestDbRole, number>;

export interface RequestDbConnections {
  strong: string;
  boundedStale: string;
  /**
   * Workerd harness only: a shorter pg-pool idle timeout, so a socket test's
   * quiet window need not outlast production's ten-second default.
   */
  poolIdleTimeoutMs?: number;
}

export interface RequestDatabaseRuntimeScope {
  connections: RequestDbConnections;
  runtimes: Partial<Record<RequestDbRole, DatabaseRuntime>>;
  clientOrdinal?: number;
  closed?: boolean;
}

type DatabaseRuntimeFactory = (
  connectionString: string,
  maxConnections: number,
  role: RequestDbRole,
  nextClientOrdinal?: () => number,
  idleTimeoutMs?: number,
) => DatabaseRuntime;

/**
 * Private role resolver used by the public Database handles. It owns the
 * strong/stale binding choice, per-request cache, Worker pool limits, and
 * module-runtime fallback as one testable policy.
 */
export class DatabaseRuntimeResolver {
  readonly #requestScope: () => RequestDatabaseRuntimeScope | undefined;
  readonly #moduleRuntime: () => DatabaseRuntime | undefined;
  readonly #createRuntime: DatabaseRuntimeFactory;

  constructor(input: {
    requestScope: () => RequestDatabaseRuntimeScope | undefined;
    moduleRuntime: () => DatabaseRuntime | undefined;
    createRuntime: DatabaseRuntimeFactory;
  }) {
    this.#requestScope = input.requestScope;
    this.#moduleRuntime = input.moduleRuntime;
    this.#createRuntime = input.createRuntime;
  }

  resolve(role: RequestDbRole): DatabaseRuntime {
    const scope = this.#requestScope();
    if (scope) {
      if (scope.closed)
        throw new Error("Database invocation scope has completed");
      const existing = scope.runtimes[role];
      if (existing) return existing;

      const connectionString =
        role === "strong"
          ? scope.connections.strong
          : scope.connections.boundedStale;
      // Hyperdrive owns lifecycle and timeouts; do not add per-session
      // overrides here.
      const runtime = this.#createRuntime(
        connectionString,
        WORKER_REQUEST_CONNECTIONS[role],
        role,
        () => (scope.clientOrdinal = (scope.clientOrdinal ?? 0) + 1),
        scope.connections.poolIdleTimeoutMs,
      );
      scope.runtimes[role] = runtime;
      return runtime;
    }

    const moduleRuntime = this.#moduleRuntime();
    if (moduleRuntime) return moduleRuntime;
    throw new Error(
      "No database instance available. On CF Workers, wrap the handler with withRequestDb().",
    );
  }
}
