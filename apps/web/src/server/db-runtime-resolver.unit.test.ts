import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import type { RequestDbRole } from "./db-pg-tracing";
import {
  DatabaseRuntimeResolver,
  type RequestDatabaseRuntimeScope,
} from "./db-runtime-resolver";
import type { DatabaseRuntime } from "./db/database";
import * as schema from "./db/schema";

const databaseRuntime = (): DatabaseRuntime => {
  const client = drizzle.mock({ schema });
  return { client, withConnection: (fn) => fn(client) };
};

describe("DatabaseRuntimeResolver", () => {
  it("lazily creates and caches independent strong and stale Worker runtimes", () => {
    const scope: RequestDatabaseRuntimeScope = {
      connections: {
        strong: "postgresql://strong.example/cubby",
        boundedStale: "postgresql://stale.example/cubby",
      },
      runtimes: {},
    };
    const calls: Array<{
      connectionString: string;
      maxConnections: number;
      role: RequestDbRole;
    }> = [];
    const resolver = new DatabaseRuntimeResolver({
      requestScope: () => scope,
      moduleRuntime: () => undefined,
      createRuntime: (connectionString, maxConnections, role) => {
        calls.push({ connectionString, maxConnections, role });
        return databaseRuntime();
      },
    });

    expect(calls).toEqual([]);
    const strong = resolver.resolve("strong");
    expect(resolver.resolve("strong")).toBe(strong);
    const stale = resolver.resolve("bounded-stale");
    expect(resolver.resolve("bounded-stale")).toBe(stale);
    expect(stale).not.toBe(strong);
    expect(calls).toEqual([
      {
        connectionString: "postgresql://strong.example/cubby",
        maxConnections: 5,
        role: "strong",
      },
      {
        connectionString: "postgresql://stale.example/cubby",
        maxConnections: 1,
        role: "bounded-stale",
      },
    ]);
  });

  it("uses the shared module runtime outside a Worker request", () => {
    const moduleRuntime = databaseRuntime();
    const resolver = new DatabaseRuntimeResolver({
      requestScope: () => undefined,
      moduleRuntime: () => moduleRuntime,
      createRuntime: () => {
        throw new Error("module resolution must not create a request pool");
      },
    });

    expect(resolver.resolve("strong")).toBe(moduleRuntime);
    expect(resolver.resolve("bounded-stale")).toBe(moduleRuntime);
  });

  it("refuses unscoped Worker access", () => {
    const resolver = new DatabaseRuntimeResolver({
      requestScope: () => undefined,
      moduleRuntime: () => undefined,
      createRuntime: () => databaseRuntime(),
    });

    expect(() => resolver.resolve("strong")).toThrow(
      "wrap the handler with withRequestDb()",
    );
  });
});
