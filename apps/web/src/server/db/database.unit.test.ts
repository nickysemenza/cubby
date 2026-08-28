import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

import { withConnection } from "~/server/db";

import { Database, type DatabaseRuntime } from "./database";
import * as schema from "./schema";

const databaseRuntime = (): DatabaseRuntime => {
  const client = drizzle.mock({ schema });
  return {
    client,
    withConnection: (fn) => fn(client),
  };
};

describe("Database runtime handle", () => {
  it("does not resolve its runtime until a repository requests the client", () => {
    const runtime = databaseRuntime();
    const resolve = vi.fn(() => runtime);
    const database = new Database(resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(database.clientForRepository()).toBe(runtime.client);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("resolves on every access so request-role context is never captured", () => {
    const first = databaseRuntime();
    const second = databaseRuntime();
    const runtimes = [first, second];
    const database = new Database(() => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("No test runtime remains");
      return runtime;
    });

    expect(database.clientForRepository()).toBe(first.client);
    expect(database.clientForRepository()).toBe(second.client);
  });

  it("binds withConnection callbacks to the selected physical client", async () => {
    const runtime = databaseRuntime();
    let selectionCount = 0;
    const selected: DatabaseRuntime["withConnection"] = async (fn) => {
      selectionCount += 1;
      return await fn(runtime.client);
    };
    const database = new Database(() => ({
      ...runtime,
      withConnection: selected,
    }));

    const result = await withConnection(database, async (scoped) => {
      expect(scoped).not.toBe(database);
      return scoped.clientForRepository() === runtime.client;
    });

    expect(result).toBe(true);
    expect(selectionCount).toBe(1);
  });
});
