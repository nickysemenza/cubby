import { mailEvent } from "@cubby/schemas/mailbox-research";
import { eq, sql, type SQL } from "drizzle-orm";

import {
  importSourceOrder,
  importSourceProduct,
} from "~/server/db/generated/entity-table-definitions.gen";
import { notDeleted } from "~/server/db/helpers/predicates";
import { related } from "~/server/db/helpers/related";

/** Eligible original evidence, independent of its USD ledger valuation. */
export const foreignReceiptSourceSql = (
  original: SQL,
): SQL<boolean> => sql<boolean>`(
  ${original} #>> '{extraction,candidate,currency}' <> 'USD'
  AND ${original} #>> '{extraction,candidate,currency}' ~ '^[A-Z]{3}$'
  AND COALESCE(${original} #>> '{extraction,candidate,sourceEvent}', '') NOT IN (${mailEvent.enum.refunded}, ${mailEvent.enum.cancelled})
)`;

/** A USD order that printed its total and item names but no item prices. */
const unpricedItemizationSourceSql = (original: SQL): SQL<boolean> =>
  sql<boolean>`(${original} #>> '{extraction,status}' = ${"needs_review"}
  AND ${original} #>> '{extraction,reason}' = ${"unpriced_itemization"})`;

/**
 * Pricing protection follows immutable provenance, even after
 * moving/reclassifying the Expense: a foreign receipt line, or an unpriced
 * itemization line whose money its aggregate Expense already carries.
 */
export const foreignExpenseOriginSql = (expenseId: SQL): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, expenseId))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ((${order.originalOrder} #>> '{extraction,candidate,currency}' IS NOT NULL
  AND ${order.originalOrder} #>> '{extraction,candidate,currency}' <> 'USD')
  OR ${unpricedItemizationSourceSql(order.originalOrder)})`,
    )
    .exists();

/** Coverage requires the current item still to belong to the original Purchase and role. */
export const foreignReceiptExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
}): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, row.id))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ${order.purchaseId} = ${row.purchaseId} AND ${foreignReceiptSourceSql(order.originalOrder)}
  AND (${order.originalOrder} #> '{extraction,candidate,lines}') -> ${binding.lineIndex} ->> ${"lineKind"} = ${row.lineKind}`,
    )
    .exists();

/** An unpriced item line of an unpriced USD itemization, still on its original Purchase and role. */
const unpricedItemizationExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
}): SQL<boolean> =>
  related(importSourceProduct, (binding) => eq(binding.expenseId, row.id))
    .join(
      importSourceOrder,
      (order, binding) => sql`${order.id} = ${binding.sourceOrderId}
  AND ${order.purchaseId} = ${row.purchaseId} AND ${unpricedItemizationSourceSql(order.originalOrder)}
  AND (${order.originalOrder} #> '{extraction,candidate,lines}') -> ${binding.lineIndex} ->> ${"lineKind"} = ${row.lineKind}
  AND EXISTS (
    SELECT 1 FROM "Expense" carried
    WHERE carried."purchaseId" = ${row.purchaseId} AND ${notDeleted("carried")}
      AND carried."lineBasis" = ${"allocation"}
      AND carried."costMinor"::numeric = (${order.originalOrder} #>> '{extraction,candidate,printedGrandTotal}')::numeric * 100
  )`,
    )
    .exists();

/**
 * An unpriced item line whose money is carried elsewhere by source provenance:
 * a foreign receipt line beside its USD settlement, or an unpriced
 * itemization line beside its printed-total aggregate. Sums and settlement
 * skip it rather than treat the Purchase as partly priced.
 */
export const unpricedForeignExpenseSql = (row: {
  id: SQL;
  purchaseId: SQL;
  lineKind: SQL;
  cost: SQL;
}): SQL<boolean> =>
  sql<boolean>`(${row.cost} IS NULL AND (${foreignReceiptExpenseSql(row)} OR ${unpricedItemizationExpenseSql(row)}))`;
