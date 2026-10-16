import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

import { withConnection } from "~/server/db";

import { Database } from "./database";
import {
  createDatabase,
  resolveDatabaseRuntime,
  type DatabaseRuntime,
} from "./database-runtime";
import * as schema from "./schema";

const databaseRuntime = (): DatabaseRuntime => {
  const client = drizzle.mock({ schema });
  return {
    client,
    withConnection: (fn) => fn(client),
  };
};

describe("Database runtime handle", () => {
  it("keeps existing handles usable across module reloads", async () => {
    const runtime = databaseRuntime();
    const database = createDatabase(() => runtime);
    vi.resetModules();
    const reloaded = await import("./database-runtime");
    const { repositoryQueries } = await import("./repository-access.boundary");

    expect(reloaded.resolveDatabaseRuntime(database).client).toBe(
      runtime.client,
    );
    expect(repositoryQueries(database)).toBe(runtime.client);
    const next = reloaded.createDatabase(() => runtime);
    expect(resolveDatabaseRuntime(next).client).toBe(runtime.client);
  });

  it("rejects a handle that has no registered runtime", () => {
    expect(() => resolveDatabaseRuntime(new Database())).toThrow(
      "Database handle has no registered runtime",
    );
  });

  it("does not resolve its runtime until a repository requests the client", () => {
    const runtime = databaseRuntime();
    const resolve = vi.fn(() => runtime);
    const database = createDatabase(resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(resolveDatabaseRuntime(database).client).toBe(runtime.client);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("resolves on every access so request-role context is never captured", () => {
    const first = databaseRuntime();
    const second = databaseRuntime();
    const runtimes = [first, second];
    const database = createDatabase(() => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("No test runtime remains");
      return runtime;
    });

    expect(resolveDatabaseRuntime(database).client).toBe(first.client);
    expect(resolveDatabaseRuntime(database).client).toBe(second.client);
  });

  it("binds withConnection callbacks to the selected physical client", async () => {
    const runtime = databaseRuntime();
    let selectionCount = 0;
    const selected: DatabaseRuntime["withConnection"] = async (fn) => {
      selectionCount += 1;
      return await fn(runtime.client);
    };
    const database = createDatabase(() => ({
      ...runtime,
      withConnection: selected,
    }));

    const result = await withConnection(database, async (scoped) => {
      expect(scoped).not.toBe(database);
      return resolveDatabaseRuntime(scoped).client === runtime.client;
    });

    expect(result).toBe(true);
    expect(selectionCount).toBe(1);
  });
});
