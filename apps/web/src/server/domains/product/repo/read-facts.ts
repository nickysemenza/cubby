import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import { productReadFacts } from "@cubby/schemas/product-read-fields";
import { foodSummary } from "@cubby/usda";
import { and, getTableColumns, sql } from "drizzle-orm";

import { categorySummarySql } from "~/server/db/computed/product-category-sql";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { loadPrimaryGtins } from "~/server/domains/product/repo/gtin";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import type { UsdaFoodBatchPort } from "~/server/domains/usda-food/repo/usda-helpers";
import { batchEnrichWithFood } from "~/server/domains/usda-food/repo/usda-helpers";
import type { DerivedCompute } from "~/server/generic/derived/repo/compute";

import { loadProductPricing } from "./pricing";

/** The hourly publication holds price facts only; stock facts are read live. */
export const computeProductReadFacts: DerivedCompute = async (db, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      ...getTableColumns(product),
      category: categorySummarySql(sql`${product.categoryId}`),
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  const pricing = await loadProductPricing(db, rows);
  return new Map(
    rows.map((row) => {
      const price = pricing.get(row.id);
      if (!price) throw new Error("Product read facts omitted an admitted row");
      const service = isServiceProductCategory(row.category);
      const value = productReadFacts.parse({
        workFacts: { priced: !service && price.effectivePrice !== null },
        pricing: price,
      });
      return [row.id, { value }];
    }),
  );
};

/** USDA lookups run in the background with the same canonical lookup precedence. */
export const productFoodCompute =
  (usdaClient: UsdaFoodBatchPort): DerivedCompute =>
  async (db, ids) => {
    if (ids.length === 0) return new Map();
    const products = await unwrapDb(db)
      .select({ id: product.id, fdc_id: product.fdc_id })
      .from(product)
      .where(
        and(
          notDeleted(product),
          sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
        ),
      );
    const gtins = await loadPrimaryGtins(
      db,
      products.map((row) => row.id),
    );
    const rows = await batchEnrichWithFood(
      products.map((row) => ({
        ...row,
        primaryGtin: gtins.get(row.id) ?? null,
      })),
      foodLookupParamFromProduct,
      usdaClient,
    );
    return new Map(
      rows.map((row) => {
        const value = foodSummary.nullable().parse(row.food);
        return [
          row.id,
          {
            value,
            sort: null,
            decision: {
              outcome:
                value === null
                  ? { kind: "empty" as const, reason: "unset" as const }
                  : { kind: "value" as const },
              provenance: { kind: "computed" as const },
              evidence: {
                fdcId: row.fdc_id,
                primaryGtin: row.primaryGtin,
                lookup: foodLookupParamFromProduct(row),
              },
            },
          },
        ];
      }),
    );
  };
