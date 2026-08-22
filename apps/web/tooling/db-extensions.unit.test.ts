import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ensureDbExtensions } from "./db-extensions";

describe("ensureDbExtensions", () => {
  it("installs query traffic statistics with the existing extensions", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await ensureDbExtensions({ execute });

    expect(execute).toHaveBeenCalledTimes(3);
    const dialect = new PgDialect();
    expect(
      execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql),
    ).toEqual([
      expect.stringContaining("pg_trgm"),
      expect.stringContaining("vector"),
      expect.stringContaining("pg_stat_statements"),
    ]);
  });
});
