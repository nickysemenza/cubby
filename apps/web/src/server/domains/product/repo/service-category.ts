import { SERVICE_PRODUCT_FEATURES } from "@cubby/schemas/product-category-fields";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { related } from "~/server/db/helpers/related";
import { product } from "~/server/db/schema";
import { categoryFeatureInSql } from "~/server/domains/product-category/repo/category-feature";

/** Use the canonical category set, preserving nearest-live-ancestor decisions. */
export const serviceCategorySql = (categoryId: SQL): SQL<boolean> =>
  categoryFeatureInSql(categoryId, SERVICE_PRODUCT_FEATURES);

export const serviceProductIdSql = (id: SQL): SQL<boolean> =>
  sql<boolean>`COALESCE(${related(product, (p) => sql`${p.id} = ${id}`).value(
    (p) => serviceCategorySql(p.categoryId),
  )}, false)`;

/** Internal, code-owned aliases only: kit projections compose SQL text. */
export const serviceProductSqlText = (idExpression: string): string =>
  new PgDialect().sqlToQuery(
    serviceProductIdSql(sql.raw(idExpression)).inlineParams(),
  ).sql;
