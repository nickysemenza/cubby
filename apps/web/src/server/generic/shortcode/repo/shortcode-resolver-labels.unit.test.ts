import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";

const dialect = new PgDialect();

describe("repository labels", () => {
  it("provides a title for every public entity", () => {
    for (const entity of shortcodeEntities) {
      expect({
        entity,
        title: Boolean(kernelScaffold(entity)?.title()),
      }).toEqual({
        entity,
        title: true,
      });
    }
  });

  it("uses the inventory product and location title for graph labels", () => {
    const query = dialect.sqlToQuery(labelSql("inventory", "t")).sql;
    expect(query).toContain('t."id"');
    expect(query).toContain('FROM "Product" p INNER JOIN "Location" l');
    expect(query).toContain('l."name"');
    expect(query).toContain('"InventoryEntry"."productId"');
    expect(query).toContain('"InventoryEntry"."locationId"');
  });
});
