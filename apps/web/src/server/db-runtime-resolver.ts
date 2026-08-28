import type { RequestDbRole } from "./db-pg-tracing";
import type { DatabaseRuntime } from "./db/database";

export interface RequestDbConnections {
  strong: string;
  boundedStale: string;
}

export interface RequestDatabaseRuntimeScope {
  connections: RequestDbConnections;
  runtimes: Partial<Record<RequestDbRole, DatabaseRuntime>>;
}

type DatabaseRuntimeFactory = (
  connectionString: string,
  maxConnections: number,
  role: RequestDbRole,
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
      const existing = scope.runtimes[role];
      if (existing) return existing;

      const connectionString =
        role === "strong"
          ? scope.connections.strong
          : scope.connections.boundedStale;
      const runtime = this.#createRuntime(
        connectionString,
        role === "strong" ? 5 : 1,
        role,
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
