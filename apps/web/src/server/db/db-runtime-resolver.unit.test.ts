import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import { relationalSchema } from "~/server/db/schema";

import type { DatabaseRuntime } from "./database-runtime";
import type { RequestDbRole } from "./db-pg-tracing";
import {
  DatabaseRuntimeResolver,
  type RequestDatabaseRuntimeScope,
} from "./db-runtime-resolver";

const databaseRuntime = (): DatabaseRuntime => {
  const client = drizzle.mock({
    relations: relationalSchema,
    paramsInErrors: true,
  });
  return { client, withConnection: (fn) => fn(client) };
};

describe("DatabaseRuntimeResolver", () => {
  const resolverFor = (scope: RequestDatabaseRuntimeScope) => {
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
    return { calls, resolver };
  };
  const connections = {
    strong: "postgresql://strong.example/cubby",
    boundedStale: "postgresql://stale.example/cubby",
  };

  it("lazily creates and caches independent strong and stale http runtimes", () => {
    const { calls, resolver } = resolverFor({
      kind: "http",
      connections,
      runtimes: {},
    });
    expect(calls).toEqual([]);
    const strong = resolver.resolve("strong");
    expect(resolver.resolve("strong")).toBe(strong);
    const stale = resolver.resolve("bounded-stale");
    expect(resolver.resolve("bounded-stale")).toBe(stale);
    expect(stale).not.toBe(strong);
    expect(calls).toEqual([
      {
        connectionString: connections.strong,
        maxConnections: 2,
        role: "strong",
      },
      {
        connectionString: connections.boundedStale,
        maxConnections: 2,
        role: "bounded-stale",
      },
    ]);
  });

  it("shares one two-socket pool between both roles in a background invocation", () => {
    const { calls, resolver } = resolverFor({
      kind: "background",
      connections,
      runtimes: {},
    });
    const stale = resolver.resolve("bounded-stale");
    expect(resolver.resolve("strong")).toBe(stale);
    expect(calls).toEqual([
      {
        connectionString: connections.strong,
        maxConnections: 2,
        role: "strong",
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
