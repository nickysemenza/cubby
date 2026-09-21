import type { ProductId } from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

import type { DrizzleClient } from "~/server/db";
import { expense, product } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";

const effectiveTrade = effectiveExpenseTradeSql();

/**
 * A tool's trade, taken from its largest principal, non-future, positive
 * Expense. `Product` has no `trade` column, so every tool surface consumes this
 * one derivation rather than approximating it independently.
 *
 * The predicate deliberately omits `costType = 'tools'`. Adding it drops real
 * trade coverage. Tie-breaks are cost descending, earliest date, then trade so
 * the answer is deterministic for contested tools.
 */
export async function deriveToolTrades(
  dbc: DrizzleClient,
  productIds?: ProductId[],
): Promise<Map<ProductId, Trade>> {
  if (productIds && productIds.length === 0) return new Map();
  const rows = await dbc
    .selectDistinctOn([expense.productId], {
      productId: expense.productId,
      trade: effectiveTrade,
    })
    .from(expense)
    .innerJoin(
      product,
      and(
        eq(product.id, expense.productId),
        eq(product.category, "tools"),
        notDeleted(product),
      ),
    )
    .where(
      and(
        productIds ? inArray(expense.productId, productIds) : undefined,
        eq(expense.lineKind, "principal"),
        eq(expense.future, false),
        gt(expense.cost, 0),
        notDeleted(expense),
      ),
    )
    .orderBy(
      asc(expense.productId),
      desc(expense.cost),
      asc(expense.date),
      asc(effectiveTrade),
    );
  return new Map(
    rows.flatMap((row) =>
      row.productId && row.trade ? [[row.productId, row.trade] as const] : [],
    ),
  );
}
