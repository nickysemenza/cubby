import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type { FieldResolution } from "@cubby/schemas/field-resolution";
import type {
  ProductCategoryId,
  ProductId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { vendorSpendingProfile } from "@cubby/schemas/spending-classification";
import { and, inArray, sql, type SQL } from "drizzle-orm";

import {
  type CategoryStockTracking,
  categoryStockTrackingSql,
  productStockTrackedSql,
} from "~/server/db/computed/product-category-sql";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/helpers/query";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { product } from "~/server/db/retained-tables";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { effectiveFieldSql } from "~/server/generic/inheritance/repo/effective-field";

/**
 * ADR 0013: a record's own stock-tracking decision wins; otherwise the
 * nearest category decision above it applies; with neither it is undecided.
 * One shape for a Product (fallback: its category's effective decision) and a
 * Product or Spending Category (fallback: its nearest deciding ancestor).
 */
export const resolveStockTrackingField = (
  stored: boolean | null,
  fallback: CategoryStockTracking | null,
  ownSource: string,
  sourceKind: "productCategory" | "spendingCategory" = "productCategory",
): FieldResolution => {
  const fallbackValue = fallback?.value ?? null;
  const fallbackSource =
    fallback?.id && fallbackValue !== null
      ? {
          entityKind: sourceKind,
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
 * An undecided Product bought on this Purchase is not stock: every one of its
 * live principal lines resolves to a not-tracked spending category, or, with
 * no category decision, the Purchase's Vendor is a food retailer.
 */
const principalLine = sqlEnumConstant(
  expenseLineKindSchema,
  expenseLineKindSchema.enum.principal,
);
const foodRetail = sqlEnumConstant(
  vendorSpendingProfile,
  vendorSpendingProfile.enum.food_retail,
);
const undecidedArrivalQuietSql = (purchaseId: PurchaseId): SQL => sql`(
  EXISTS (
    SELECT 1 FROM "Expense" arrival_line
    WHERE arrival_line."purchaseId" = ${purchaseId}
      AND arrival_line."productId" = ${product.id}
      AND arrival_line."lineKind" = ${principalLine}
      AND arrival_line."deletedAt" IS NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM "Expense" arrival_line
    JOIN "Purchase" arrival_purchase ON arrival_purchase.id = arrival_line."purchaseId"
    LEFT JOIN "Vendor" arrival_vendor ON arrival_vendor.id = arrival_purchase."vendorId"
      AND arrival_vendor."deletedAt" IS NULL
    WHERE arrival_line."purchaseId" = ${purchaseId}
      AND arrival_line."productId" = ${product.id}
      AND arrival_line."lineKind" = ${principalLine}
      AND arrival_line."deletedAt" IS NULL
      AND arrival_purchase."deletedAt" IS NULL
      AND COALESCE(
        ${effectiveFieldSql("spendingCategory", "stockTracked", { id: effectiveExpenseSpendingCategorySql("arrival_line") })},
        CASE WHEN arrival_vendor."spendingProfile" = ${foodRetail} THEN false END
      ) IS DISTINCT FROM false
  )
)`;

/**
 * The Products among `ids` whose arrival on `purchaseId` asks to be received:
 * effectively stock-tracked, or still undecided so a member makes the call.
 * An explicit or inherited `false` stays quiet (ADR 0013), and so does an
 * undecided Product on a not-tracked spending context (see
 * `undecidedArrivalQuietSql`); a Product's own decision always wins. Shared by
 * the import writer, which files the `arrived` finding, and its resolution,
 * which waits for exactly these Products to be stocked.
 */
export const receivableProductIds = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
  purchaseId: PurchaseId,
): Promise<Set<ProductId>> => {
  if (ids.length === 0) return new Set();
  const tracking = productStockTrackedSql(
    sql`${product.stockTracked}`,
    sql`${product.categoryId}`,
  );
  const rows = await unwrapDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        inArray(product.id, [...new Set(ids)]),
        notDeleted(product),
        sql`${tracking} IS DISTINCT FROM false`,
        sql`NOT (${tracking} IS NULL AND ${undecidedArrivalQuietSql(purchaseId)})`,
      ),
    );
  return new Set(rows.map((row) => row.id));
};
