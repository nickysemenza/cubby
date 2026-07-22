import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/project";
import { purchaseSortableFields } from "@cubby/schemas/project";
import { eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import type { Database } from "~/server/db";
import { purchase } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  relations,
} from "~/server/repo/database-helpers";
import {
  allProjectParentRows,
  buildChildrenMap,
  collectDescendantIds,
} from "~/server/repo/project/subtree";
import { dbPurchaseToAPI } from "./helpers";

/**
 * Translate `PurchaseFilters` into the exact Drizzle WHERE clause used to
 * scope purchase rows. Shared by `purchaseList` (the ledger) and
 * `purchaseAnalytics` (repo/purchase/analytics.ts) so the two can never
 * drift under the same filter set — the plan's hard invariant is "ledger
 * totals and analytics totals always agree".
 */
export const buildPurchaseWhereClause = async (
  db: Database,
  filters: PurchaseFilters,
): Promise<SQL | undefined> => {
  // When scoped to a project subtree, resolve the project + every live
  // descendant id and match on the whole set; otherwise a plain project match.
  let projectCondition = filters.projectId
    ? eq(purchase.projectId, filters.projectId)
    : undefined;
  if (filters.projectId && filters.includeSubProjects) {
    const parentRows = await allProjectParentRows(db);
    const descendantIds = collectDescendantIds(
      buildChildrenMap(parentRows),
      filters.projectId,
    );
    projectCondition = inArray(purchase.projectId, [
      filters.projectId,
      ...descendantIds,
    ]);
  }

  return buildSearchConditions(
    purchase,
    [{ column: purchase.name, term: filters.search }],
    [
      filters.costType ? eq(purchase.costType, filters.costType) : undefined,
      filters.trade ? eq(purchase.trade, filters.trade) : undefined,
      projectCondition,
      filters.future !== undefined
        ? eq(purchase.future, filters.future)
        : undefined,
      // Rows with a null `date` (common on `future` purchases — nothing to
      // date yet) fall out of any date window by plain SQL comparison
      // semantics; that's intended, not a bug to work around.
      filters.dateFrom ? gte(purchase.date, filters.dateFrom) : undefined,
      filters.dateTo ? lte(purchase.date, filters.dateTo) : undefined,
      filters.costIsNull ? isNull(purchase.cost) : undefined,
    ],
  );
};

export const purchaseList = async (
  db: Database,
  filters: PurchaseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: PurchaseOut[]; count: number }> => {
  const whereClause = await buildPurchaseWhereClause(db, filters);

  const orderByArray = buildOrderBy(purchase, sorts, [
    ...purchaseSortableFields,
  ]);
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.purchase.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.purchase.withProject,
    }),
    countWhere(db, purchase, whereClause),
  );

  return { data: rows.map(dbPurchaseToAPI), count };
};
