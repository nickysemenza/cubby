import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/project";
import { purchaseSortableFields } from "@cubby/schemas/project";
import { eq, inArray } from "drizzle-orm";
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

export const purchaseList = async (
  db: Database,
  filters: PurchaseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: PurchaseOut[]; count: number }> => {
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

  const whereClause = buildSearchConditions(
    purchase,
    [{ column: purchase.name, term: filters.search }],
    [
      filters.costType ? eq(purchase.costType, filters.costType) : undefined,
      filters.trade ? eq(purchase.trade, filters.trade) : undefined,
      projectCondition,
      filters.future !== undefined
        ? eq(purchase.future, filters.future)
        : undefined,
    ],
  );

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
