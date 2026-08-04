/**
 * When a Product entered and left the household.
 *
 * Nothing is stored: `Expense.productId`'s own doc note is explicit that "net
 * cost, ownership window and owned/sold status are derived from these rows plus
 * inventory". This module is the one place that derivation lives, so the
 * suggestion engine, the tools matrix, the usage-edge write guard and
 * `findSoldButStillStocked` all read the same dates.
 *
 * The disposal predicates are not obvious and were learned from live data —
 * see the essay above `findSoldButStillStocked` for why a disposal is a
 * Purchase that *nets negative* rather than any negative line (the loose
 * version was wrong about half the time), and why a later acquisition has to
 * reopen the window.
 */
import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  type ProductOwnershipWindow,
  UNKNOWN_OWNERSHIP,
} from "~/lib/tool-timeline";
import type { DrizzleClient } from "~/server/db";
import { expense } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

export type { ProductOwnershipWindow };

/**
 * Purchases whose Expenses sum negative — the shape a disposal is modelled in.
 * A drizzle subquery rather than a materialized id list so callers keep it
 * inside their own `inArray`, which is how `findSoldButStillStocked` already
 * used it.
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

/**
 * Batch-load ownership windows. Two grouped queries, constant in product count.
 *
 * The two acquisition aggregates are deliberately different predicates:
 *
 *  - `acquiredAt` is the first **principal** positive line — the purchase
 *    itself, not a later accessory, tax split, or price adjustment. A product
 *    with no principal positive line yields `null`, which every consumer reads
 *    as "unknown, do not restrict".
 *  - the *reopening* comparison uses the last positive line of **any** kind,
 *    matching `findSoldButStillStocked` exactly. That side is deliberately
 *    loose: it errs toward "still owned", which is the safe direction for both
 *    a detector a human reviews and a gate that blocks a write.
 */
export async function loadProductOwnershipWindows(
  dbc: DrizzleClient,
  productIds: ProductId[],
): Promise<Map<ProductId, ProductOwnershipWindow>> {
  const result = new Map<ProductId, ProductOwnershipWindow>();
  if (productIds.length === 0) return result;
  for (const productId of productIds) {
    result.set(productId, { ...UNKNOWN_OWNERSHIP });
  }

  const [acquisitionRows, exitRows] = await Promise.all([
    dbc
      .select({
        productId: expense.productId,
        firstAcquiredAt: sql<
          string | null
        >`min(${expense.date}) FILTER (WHERE ${expense.lineKind} = 'principal')`,
        lastAcquiredAt: sql<string | null>`max(${expense.date})`,
      })
      .from(expense)
      .where(
        and(
          inArray(expense.productId, productIds),
          eq(expense.future, false),
          gt(expense.cost, 0),
          notDeleted(expense),
        ),
      )
      .groupBy(expense.productId),
    dbc
      .select({
        productId: expense.productId,
        lastExitAt: sql<string | null>`max(${expense.date})`,
      })
      .from(expense)
      .where(
        and(
          inArray(expense.productId, productIds),
          eq(expense.future, false),
          lt(expense.cost, 0),
          inArray(expense.purchaseId, disposalPurchaseIds(dbc)),
          notDeleted(expense),
        ),
      )
      .groupBy(expense.productId),
  ]);

  const lastAcquiredAt = new Map<ProductId, string | null>();
  for (const row of acquisitionRows) {
    if (!row.productId) continue;
    lastAcquiredAt.set(row.productId, row.lastAcquiredAt);
    const current = result.get(row.productId);
    if (current) current.acquiredAt = row.firstAcquiredAt;
  }

  for (const row of exitRows) {
    if (!row.productId || !row.lastExitAt) continue;
    const current = result.get(row.productId);
    if (!current) continue;
    // Re-acquired after the last exit, so the window is open again. Ties keep
    // the disposal: a same-day sell-and-rebuy is not distinguishable at date
    // granularity, and the ambiguity is one a human resolves.
    const reacquired = lastAcquiredAt.get(row.productId);
    if (reacquired && reacquired > row.lastExitAt) continue;
    current.disposedAt = row.lastExitAt;
  }

  return result;
}
