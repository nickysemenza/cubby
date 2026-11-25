/**
 * Correlated SQL for the Product stock predicates that list filters, saved
 * views and Work sources select by. Each is the SQL form of the matching
 * `workFacts` member in `loadProductStockFacts`; change both together.
 */
import { type SQL, and, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { notDeleted } from "~/server/db/helpers";
import { expense } from "~/server/db/schema";

import { ownershipExitExpensePredicate } from "./ownership";
import {
  expectedQuantitySql,
  knownNonpositiveQuantitySql,
  onHandUnitsSql,
  unknownQuantityLinesSql,
} from "./quantity-ledger";

const qb = new QueryBuilder();

const partsAccountedKits = (productId: SQL) =>
  sql`SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity")) AS accounted
       FROM "EntityLink" kac
       JOIN "Product" kac_p
         ON kac_p."id" = kac."toEntityId" AND ${notDeleted("kac_p")}
      WHERE kac."fromEntityId" = ${productId}
        AND ${notDeleted("kac")} AND kac."kind" = 'productComponent'`;

/** Whole kits its live parts could reassemble; null without component edges. */
export const partsAccountedKitsSql = (productId: SQL) =>
  sql`(${partsAccountedKits(productId)})`;

/** Products with a live recorded disposal; unlinked disposal Expenses count. */
const disposedProductIds = () =>
  qb
    .select({ id: expense.productId })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        actualExpense(),
        isNotNull(expense.productId),
        ownershipExitExpensePredicate(),
      ),
    );

/** `productAlias` is the enclosing plain select's alias, e.g. `"Product"`. */
export const productWorkFactsSql = (
  productAlias: string,
  hasPlacement: SQL,
) => {
  const onHand = sql.raw(onHandUnitsSql(productAlias));
  const expected = sql.raw(expectedQuantitySql(productAlias));
  const id = sql.raw(`${productAlias}."id"`);
  const componentParents = sql`SELECT link."fromEntityId" FROM "EntityLink" link
    WHERE link."kind" = 'productComponent' AND ${notDeleted("link")}`;
  // Identify the stock and evidence populations before probing any ledger.
  return {
    kitAccounting: sql<boolean>`CASE WHEN (${hasPlacement}) AND ${id} IN (${componentParents}) THEN
      (SELECT CASE WHEN stock.units > 0 AND parts.accounted > 0
        THEN stock.units + parts.accounted > ${expected} ELSE false END
       FROM (SELECT ${onHand} AS units OFFSET 0) stock,
            (${partsAccountedKits(id)}) parts)
      ELSE false END`,
    ownershipReconciliation: sql<boolean>`CASE WHEN (${hasPlacement}) AND ${id} IN (${disposedProductIds()}) THEN
      CASE WHEN ${onHand} > 0 THEN ${sql.raw(knownNonpositiveQuantitySql(productAlias))}
        ELSE false END
      ELSE false END`,
    unknownQuantityLines: sql<boolean>`${sql.raw(unknownQuantityLinesSql(productAlias))} > 0`,
  };
};
