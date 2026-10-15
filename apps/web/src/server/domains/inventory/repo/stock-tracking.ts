import type { FieldResolution } from "@cubby/schemas/field-resolution";
import type { ProductCategoryId, ProductId } from "@cubby/schemas/identifiers";
import { and, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type CategoryStockTracking,
  categoryStockTrackingSql,
  productStockTrackedSql,
} from "~/server/db/computed/product-category-sql";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";

/**
 * ADR 0013: a record's own stock-tracking decision wins; otherwise the
 * nearest category decision above it applies; with neither it is undecided.
 * One shape for a Product (fallback: its category's effective decision) and a
 * Product Category (fallback: its nearest deciding ancestor).
 */
export const resolveStockTrackingField = (
  stored: boolean | null,
  fallback: CategoryStockTracking | null,
  ownSource: string,
): FieldResolution => {
  const fallbackValue = fallback?.value ?? null;
  const fallbackSource =
    fallback?.id && fallbackValue !== null
      ? {
          entityKind: "productCategory" as const,
          entityId: fallback.id,
          name: fallback.name,
        }
      : null;
  return {
    mode: stored === null ? "inherit" : "explicit",
    storedValue: stored,
    value: stored ?? fallbackValue,
    fallbackValue,
    source: stored !== null ? ownSource : (fallback?.name ?? "undecided"),
    sourceEntity: stored === null ? fallbackSource : null,
    fallbackSource,
    evaluation:
      fallback?.evaluation ??
      (fallbackSource
        ? [{ ...fallbackSource, value: fallbackValue, assigned: true }]
        : []),
    matchesFallback: stored !== null && stored === fallbackValue,
    canReset: stored !== null,
  };
};

/** The decision a Product in `categoryId` inherits, for single-row writes
 * that build their response without the relational read projection. */
export const loadCategoryStockTracking = async (
  db: Database | DrizzleTransaction,
  categoryId: ProductCategoryId | null,
): Promise<CategoryStockTracking | null> => {
  if (!categoryId) return null;
  const rows = await unwrapDb(db).execute<{
    tracking: CategoryStockTracking | null;
  }>(
    sql`SELECT ${categoryStockTrackingSql(sql`${categoryId}::uuid`)} AS tracking`,
  );
  return rows.rows[0]?.tracking ?? null;
};

/**
 * The Products among `ids` whose arrival asks to be received: effectively
 * stock-tracked, or still undecided so a member makes the call. Only an
 * explicit or inherited `false` stays quiet (ADR 0013). Shared by the import
 * writer, which files the `arrived` finding, and its resolution, which waits
 * for exactly these Products to be stocked.
 */
export const receivableProductIds = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Set<ProductId>> => {
  if (ids.length === 0) return new Set();
  const rows = await unwrapDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        inArray(product.id, [...new Set(ids)]),
        notDeleted(product),
        sql`${productStockTrackedSql(
          sql`${product.stockTracked}`,
          sql`${product.categoryId}`,
        )} IS DISTINCT FROM false`,
      ),
    );
  return new Set(rows.map((row) => row.id));
};
