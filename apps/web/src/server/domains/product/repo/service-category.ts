import { SERVICE_PRODUCT_FEATURES } from "@cubby/schemas/product-category-fields";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { categoryFeatureInSql } from "~/server/domains/product-category/repo/category-feature";

/** Use the canonical category set, preserving nearest-live-ancestor decisions. */
export const serviceCategorySql = (categoryId: SQL): SQL<boolean> =>
  categoryFeatureInSql(categoryId, SERVICE_PRODUCT_FEATURES);

export const serviceProductIdSql = (id: SQL): SQL<boolean> =>
  sql<boolean>`COALESCE((SELECT ${serviceCategorySql(sql`service_product."categoryId"`)} FROM "Product" service_product WHERE service_product."id" = ${id} AND service_product."deletedAt" IS NULL), false)`;

/** Internal, code-owned aliases only: kit projections compose SQL text. */
export const serviceProductSqlText = (idExpression: string): string =>
  new PgDialect().sqlToQuery(
    serviceProductIdSql(sql.raw(idExpression)).inlineParams(),
  ).sql;
