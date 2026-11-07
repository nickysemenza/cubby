import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { outer } from "~/server/db/helpers/related";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { relationalSchema } from "~/server/db/schema";
import { product } from "~/server/db/schema";

import { categoryFeatureSql } from "./category-feature";

/**
 * ⚠️ REGRESSION GUARD: `categoryFeatureSql` (through `effectiveFieldSql`) and
 * `categorySummarySql` inline their depth/feature constants with `sql.raw`
 * instead of `.inlineParams()` because
 * relational expressions must retain the literals when their row alias is
 * bound. Assert both plain-select and relational extras call shapes.
 */
describe("categoryFeatureSql", () => {
  const categoryIdExpr = outer(product.categoryId);

  it("inlines the depth and feature literals under a plain select", () => {
    const db = drizzle.mock({
      relations: relationalSchema,
      paramsInErrors: true,
    });
    const built = db
      .select({ x: categoryFeatureSql(categoryIdExpr, "food") })
      .from(product)
      .toSQL();

    expect(built.sql).toContain('"ih_depth" < 2');
    expect(built.sql).toContain(`IN ('food')`);
    expect(built.params).toEqual([]);
  });

  it("still inlines the depth and feature literals under the relational extras path", () => {
    const db = drizzle.mock({
      relations: relationalSchema,
      paramsInErrors: true,
    });
    const built = db.query.product
      .findFirst({
        extras: {
          x: (table: PgTable) =>
            relationalSql(
              table,
              categoryFeatureSql(categoryIdExpr, "food").as("x"),
            ),
        },
      })
      .toSQL();

    expect(built.sql).toContain('"ih_depth" < 2');
    expect(built.sql).toContain(`IN ('food')`);
    // A relational findFirst may still bind its own LIMIT param — only the
    // depth (2) and feature ("food") literals must be absent from params.
    expect(built.params).not.toContain(2);
    expect(built.params).not.toContain("food");
  });

  it("throws for a feature outside the validated enum", () => {
    expect(() =>
      categoryFeatureSql(categoryIdExpr, "not-a-feature" as never),
    ).toThrow("Invalid product category feature");
  });
});
