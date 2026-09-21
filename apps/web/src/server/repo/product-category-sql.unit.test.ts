import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import * as schema from "~/server/db/schema";

import { categoryFeatureSql } from "./product-category-sql";

/**
 * ⚠️ REGRESSION GUARD: `categoryFeatureSql`/`categorySummarySql` inline their
 * depth/feature constants with `sql.raw` instead of `.inlineParams()` because
 * drizzle's relational `extras` path (`mapColumnsInSQLToAlias`, alias.js)
 * rebuilds nested SQL via `sql.join(...)`, which silently drops the inline
 * flag `.inlineParams()` relies on. Under `db.select`, the bug never surfaces
 * — only the relational `extras` path (as `expenseInheritanceReadExtras` and
 * `relations.ts` use these) hits the code path that drops it, which is why
 * both call shapes must be asserted here.
 */
describe("categoryFeatureSql", () => {
  const categoryIdExpr = sql.raw('"product"."categoryId"');

  it("inlines the depth and feature literals under a plain select", () => {
    const db = drizzle.mock({ schema });
    const built = db
      .select({ x: categoryFeatureSql(categoryIdExpr, "food") })
      .from(product)
      .toSQL();

    expect(built.sql).toContain("a.depth < 2");
    expect(built.sql).toContain(`"feature" = 'food'`);
    expect(built.params).toEqual([]);
  });

  it("still inlines the depth and feature literals under the relational extras path", () => {
    const db = drizzle.mock({ schema });
    const built = db.query.product
      .findFirst({
        extras: {
          x: categoryFeatureSql(categoryIdExpr, "food").as("x"),
        },
      })
      .toSQL();

    expect(built.sql).toContain("a.depth < 2");
    expect(built.sql).toContain(`"feature" = 'food'`);
    // A relational findFirst may still bind its own LIMIT param — only the
    // depth (2) and feature ("food") literals must be absent from params.
    expect(built.params).not.toContain(2);
    expect(built.params).not.toContain("food");
  });

  it("throws for a feature outside the validated enum", () => {
    // SAFETY: exercising the runtime guard against a value that bypasses the
    // compile-time `ProductCategoryFeature` union, so the cast is intentional.
    expect(() =>
      categoryFeatureSql(categoryIdExpr, "not-a-feature" as never),
    ).toThrow("Invalid product category feature");
  });
});
