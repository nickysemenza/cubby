import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/project";
import { purchaseSortableFields } from "@cubby/schemas/project";
import {
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { purchase } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
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
  // When scoped to a project subtree, resolve each selected project + every
  // live descendant and match on the whole set; otherwise a plain match on the
  // selection (one project or several — see `eqAny`).
  const selectedProjectIds = filters.projectId
    ? [filters.projectId].flat()
    : [];
  let projectCondition = eqAny(purchase.projectId, filters.projectId);
  if (selectedProjectIds.length > 0 && filters.includeSubProjects) {
    const childrenMap = buildChildrenMap(await allProjectParentRows(db));
    projectCondition = inArray(
      purchase.projectId,
      uniq(
        selectedProjectIds.flatMap((id) => [
          id,
          ...collectDescendantIds(childrenMap, id),
        ]),
      ),
    );
  }

  // `search` stays a single-column term: buildSearchConditions ANDs its
  // searchFilters entries, so adding `{ column: vendor, term: filters.search }`
  // here would mean `name ILIKE q AND vendor ILIKE q` — and vendor is null on
  // nearly every row, which would silently zero out purchase search. Vendor
  // matching is its own filter, applied below.
  return buildSearchConditions(
    purchase,
    [{ column: purchase.name, term: filters.search }],
    [
      eqAny(purchase.costType, filters.costType),
      eqAny(purchase.trade, filters.trade),
      projectCondition,
      eqAny(purchase.productId, filters.productId),
      // "linked" means productId IS NOT NULL — this deliberately includes
      // purchases whose product was later soft-deleted (those read back with
      // productId still set and productName null; see dbPurchaseToAPI).
      filters.productPresenceFilter === "has"
        ? isNotNull(purchase.productId)
        : undefined,
      filters.productPresenceFilter === "none"
        ? isNull(purchase.productId)
        : undefined,
      formatSearchTerm(purchase.vendor, filters.vendor),
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

/**
 * Sorts the generic column path can't produce: the joined project/product
 * names shown in those columns aren't columns on `purchase`.
 *
 * Correlated subqueries rather than joins so `purchaseList` stays a relational
 * `findMany` (its count query is then untouched). The soft-delete guard mirrors
 * what `resolveLiveJoinName` applies on read, so a purchase whose project or
 * product was deleted sorts as null — the same way it renders.
 *
 * NULLS LAST in both directions is the house convention (see `buildOrderBy`).
 * `trade` needs no entry: it's a plain text column, so it falls through to the
 * generic path and sorts alphabetically.
 */
const resolvePurchaseSort = (sort: SortParams) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";

  if (sort.orderBy === "project") {
    return [
      sql.raw(
        `(SELECT p."name" FROM "Project" p ` +
          `WHERE p."id" = "purchase"."projectId" AND p."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "product") {
    return [
      sql.raw(
        `(SELECT pr."name" FROM "Product" pr ` +
          `WHERE pr."id" = "purchase"."productId" AND pr."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  return null;
};

export const purchaseList = async (
  db: Database,
  filters: PurchaseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: PurchaseOut[]; count: number }> => {
  const whereClause = await buildPurchaseWhereClause(db, filters);

  const orderByArray = buildOrderBy(
    purchase,
    sorts,
    [...purchaseSortableFields],
    {
      resolve: resolvePurchaseSort,
    },
  );
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
