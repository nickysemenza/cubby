/**
 * Quantity-aware Product ownership history.
 *
 * The same movement classifier and interval fold power the product movement
 * timeline. Keeping tool suggestions, the matrix, write guards and Problems on
 * that shared interpretation prevents a partial exit from masquerading as a
 * full disposal and preserves real sell/re-buy gaps.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { householdLocalDate } from "~/lib/household-date";
import {
  buildConfidentOwnershipIntervals,
  classifyProductMovement,
} from "~/lib/product-movement";
import type { ProductOwnershipTimeline } from "~/lib/tool-timeline";
import { UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import type { DrizzleClient } from "~/server/db";
import { expense, purchase } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

export type { ProductOwnershipTimeline };

/**
 * Purchases whose Expenses sum negative — the shape a disposal is modelled in.
 * The stale-stock detector uses this stricter signal so an ordinary refund does
 * not become a sale. Quantity timelines intentionally classify every signed
 * movement instead: a quantified return really did remove a unit.
 */
export const disposalPurchaseIds = (dbc: DrizzleClient) =>
  dbc
    .select({ id: expense.purchaseId })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        isNotNull(expense.purchaseId),
      ),
    )
    .groupBy(expense.purchaseId)
    .having(sql`sum(${expense.cost}) < 0`);

type OwnershipLoadOptions = {
  /** Plain-date override for deterministic project/timeline tests. */
  today?: string;
};

/**
 * Batch-load proven ownership intervals in one query, constant in product
 * count. `acquiredAt` remains independently useful for legacy quantity-less
 * acquisitions: they prove the product was not owned before that date, while
 * `confidenceLostAt` keeps everything from that movement onward permissive.
 */
export async function loadProductOwnershipTimelines(
  dbc: DrizzleClient,
  productIds: ProductId[],
  options: OwnershipLoadOptions = {},
): Promise<Map<ProductId, ProductOwnershipTimeline>> {
  const result = new Map<ProductId, ProductOwnershipTimeline>();
  if (productIds.length === 0) return result;
  for (const productId of productIds) {
    result.set(productId, { ...UNKNOWN_OWNERSHIP, intervals: [] });
  }

  const rows = await dbc
    .select({
      productId: expense.productId,
      expenseDate: expense.date,
      purchaseDate: purchase.date,
      cost: expense.cost,
      quantity: expense.productQuantity,
      lineKind: expense.lineKind,
    })
    .from(expense)
    .leftJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .where(
      and(
        inArray(expense.productId, productIds),
        eq(expense.future, false),
        notDeleted(expense),
      ),
    );

  const rowsByProduct = new Map<ProductId, typeof rows>();
  for (const row of rows) {
    if (row.productId === null) continue;
    const bucket = rowsByProduct.get(row.productId) ?? [];
    bucket.push(row);
    rowsByProduct.set(row.productId, bucket);
  }

  const today = options.today ?? householdLocalDate();
  for (const productId of productIds) {
    const productRows = rowsByProduct.get(productId) ?? [];
    const acquisitionDates = productRows.flatMap((row) =>
      row.cost !== null && row.cost > 0 && row.lineKind === "principal"
        ? [row.purchaseDate ?? row.expenseDate]
        : [],
    );
    acquisitionDates.sort();

    const ownership = buildConfidentOwnershipIntervals(
      productRows.map((row) => ({
        date: row.purchaseDate ?? row.expenseDate,
        signedQuantity: classifyProductMovement(row.cost, row.quantity)
          .signedQuantity,
      })),
      today,
    );
    result.set(productId, {
      acquiredAt: acquisitionDates[0] ?? ownership.intervals[0]?.start ?? null,
      intervals: ownership.intervals,
      confidenceLostAt: ownership.confidenceLostAt,
    });
  }

  return result;
}
