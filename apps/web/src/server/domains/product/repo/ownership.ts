/**
 * Quantity-aware Product ownership history.
 *
 * The same movement classifier and interval fold power the product movement
 * timeline. Keeping tool suggestions, the matrix, write guards and Problems on
 * that shared interpretation prevents a partial exit from masquerading as a
 * full disposal and preserves real sell/re-buy gaps.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import {
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type PgColumn, QueryBuilder } from "drizzle-orm/pg-core";

import { householdLocalDate } from "~/lib/household-date";
import type { ProductOwnershipTimeline } from "~/lib/tool-timeline";
import { UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import type { DrizzleClient } from "~/server/db";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { notDeleted } from "~/server/db/helpers";
import { expense, purchase } from "~/server/db/schema";
import {
  buildConfidentOwnershipIntervals,
  classifyProductMovement,
} from "~/server/domains/product/repo/product-movement";
import { serviceProductIdSql } from "~/server/domains/product/repo/service-category";

export type { ProductOwnershipTimeline };

/**
 * Purchases whose Expenses sum negative — the shape a disposal is modelled in.
 * The stale-stock detector uses this stricter signal so an ordinary refund does
 * not become a sale. Quantity timelines intentionally classify every signed
 * movement instead: a quantified return really did remove a unit.
 */
// Uncorrelated, so list filters can share it without a client.
const qb = new QueryBuilder();

export const disposalPurchaseIds = () =>
  qb
    .select({ id: expense.purchaseId })
    .from(expense)
    .where(
      and(notDeleted(expense), actualExpense(), isNotNull(expense.purchaseId)),
    )
    .groupBy(expense.purchaseId)
    .having(sql`sum(${expense.cost}) < 0`);

/** A zero-cost negative quantity records an ownership exit, not an acquisition. */
export const zeroCostOwnershipExitExpensePredicate = (): SQL =>
  and(eq(expense.cost, 0), lt(expense.productQuantity, 0))!;

/**
 * Expenses that close ownership for the stale-stock detector.
 *
 * A negative line needs a net-negative Purchase to distinguish a disposal from
 * an ordinary refund. With no money moving, though, the signed quantity is the
 * fact: a negative quantity is a hand-entered discard while a positive one is
 * a free acquisition. Keep this shared by the canonical Product filter and
 * Problems presenter so selection and card totals cannot drift.
 */
export const ownershipExitExpensePredicate = (): SQL =>
  or(
    and(lt(expense.cost, 0), purchaseNetsNegative(expense.purchaseId)),
    zeroCostOwnershipExitExpensePredicate(),
  )!;

/**
 * `disposalPurchaseIds` for one Expense's Purchase. The correlated sum reads
 * that Purchase's lines through the purchaseId index; the uncorrelated set
 * scans every Expense, which also takes a relation-wide read in SERIALIZABLE
 * transactions.
 */
const purchaseNetsNegative = (purchaseId: SQL | PgColumn): SQL =>
  sql`(SELECT sum(net."cost") FROM ${expense} net
    WHERE net."purchaseId" = ${purchaseId} AND ${notDeleted("net")} AND net."future" = false) < 0`;

type OwnershipLoadOptions = {
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
        actualExpense(),
        notDeleted(expense),
        sql`NOT ${serviceProductIdSql(sql`${expense.productId}`)}`,
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
    const markers = productRows.map((row) => ({
      // A line without its own date is undated even on a dated Purchase, as
      // in the movement timeline; dated lines take their Purchase's date.
      date:
        row.expenseDate === null ? null : (row.purchaseDate ?? row.expenseDate),
      signedQuantity: classifyProductMovement(row.cost, row.quantity)
        .signedQuantity,
    }));
    // Only undated quantified exits leave the dated history provable.
    if (
      markers.some(
        (marker) =>
          marker.date === null &&
          (marker.signedQuantity === null || marker.signedQuantity >= 0),
      )
    )
      continue;
    const acquisitionDates = productRows.flatMap((row) =>
      row.cost !== null &&
      row.cost > 0 &&
      row.lineKind === "principal" &&
      row.expenseDate !== null
        ? [row.purchaseDate ?? row.expenseDate]
        : [],
    );
    acquisitionDates.sort();

    const ownership = buildConfidentOwnershipIntervals(markers, today);
    result.set(productId, {
      acquiredAt: acquisitionDates[0] ?? ownership.intervals[0]?.start ?? null,
      intervals: ownership.intervals,
      confidenceLostAt: ownership.confidenceLostAt,
      ...(ownership.undatedExits ? { undatedExits: true } : {}),
    });
  }

  return result;
}
