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
  onHandUnitsSql,
  unknownAcquisitionLinesSql,
  unknownQuantityLinesSql,
} from "./quantity-ledger";

const qb = new QueryBuilder();

/** Whole kits its live parts could reassemble; null without component edges. */
export const partsAccountedKitsSql = (productId: SQL) =>
  sql`(SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity"))
       FROM "EntityLink" kac
       JOIN "Product" kac_p
         ON kac_p."id" = kac."toEntityId" AND ${notDeleted("kac_p")}
      WHERE kac."fromEntityId" = ${productId}
        AND ${notDeleted("kac")} AND kac."kind" = 'productComponent')`;

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
export const productWorkFactsSql = (productAlias: string) => {
  const onHand = sql.raw(onHandUnitsSql(productAlias));
  const expected = sql.raw(expectedQuantitySql(productAlias));
  const id = sql.raw(`${productAlias}."id"`);
  const accounted = partsAccountedKitsSql(id);
  return {
    kitAccounting: sql<boolean>`COALESCE(${onHand} > 0 AND ${accounted} > 0
      AND ${onHand} + ${accounted} > ${expected}, false)`,
    ownershipReconciliation: sql<boolean>`COALESCE(${id} IN (${disposedProductIds()})
      AND ${onHand} > 0 AND ${expected} <= 0
      AND ${sql.raw(unknownAcquisitionLinesSql(productAlias))} = 0, false)`,
    unknownQuantityLines: sql<boolean>`${sql.raw(unknownQuantityLinesSql(productAlias))} > 0`,
  };
};
