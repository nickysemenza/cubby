import {acceptedOrderLinesSql} from "~/server/domains/purchase-import/repo/accepted-order-read";
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
export const foreignExpenseOriginSql = (expenseId: SQL): SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM ${acceptedOrderLinesSql} accepted WHERE accepted."expenseId"=${expenseId}
  AND ((accepted.extraction#>>'{candidate,currency}' IS NOT NULL AND accepted.extraction#>>'{candidate,currency}' <> 'USD')
    OR ${unpricedItemizationSourceSql(sql`accepted."originalOrder"`)}))`;

/** Coverage follows accepted item identity and its current line role. */
export const foreignReceiptExpenseSql = (row:{id:SQL;purchaseId:SQL;lineKind:SQL}):SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM ${acceptedOrderLinesSql} accepted WHERE accepted."expenseId"=${row.id} AND accepted."purchaseId"=${row.purchaseId}
  AND ${foreignReceiptSourceSql(sql`accepted."originalOrder"`)}
  AND (accepted.extraction#>'{candidate,lines}')->accepted."lineIndex"->>'lineKind'=${row.lineKind})`;

const unpricedItemizationExpenseSql = (row:{id:SQL;purchaseId:SQL;lineKind:SQL}):SQL<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM ${acceptedOrderLinesSql} accepted WHERE accepted."expenseId"=${row.id} AND accepted."purchaseId"=${row.purchaseId}
  AND ${unpricedItemizationSourceSql(sql`accepted."originalOrder"`)}
  AND (accepted.extraction#>'{candidate,lines}')->accepted."lineIndex"->>'lineKind'=${row.lineKind}
  AND EXISTS(SELECT 1 FROM "Expense" carried WHERE carried."purchaseId"=${row.purchaseId} AND ${notDeleted("carried")}
    AND carried."lineBasis"='allocation' AND carried."costMinor"::numeric=(accepted.extraction#>>'{candidate,printedGrandTotal}')::numeric*100))`;

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
