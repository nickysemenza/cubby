import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { labelSql } from "~/server/generic/entity-graph/repo/record-label";

const dialect = new PgDialect();

describe("repository labels", () => {
  it("uses the inventory product and location title for graph labels", async () => {
    const query = dialect.sqlToQuery(await labelSql("inventory", "t")).sql;
    expect(query).toContain('t."id"');
    expect(query).toContain('FROM "Product" p INNER JOIN "Location" l');
    expect(query).toContain('l."name"');
    expect(query).toContain('"InventoryEntry"."productId"');
    expect(query).toContain('"InventoryEntry"."locationId"');
  });
});
