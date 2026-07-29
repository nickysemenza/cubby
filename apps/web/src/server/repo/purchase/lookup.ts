import type { PurchaseId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  PurchaseFilters,
  PurchaseOut,
  PurchaseVendorOptionsOut,
} from "@cubby/schemas/project";
import { purchaseSortableFields } from "@cubby/schemas/project";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
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
  eqAnyOrPresence,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  presenceCondition,
  relations,
} from "~/server/repo/database-helpers";
import {
  collectDescendantIds,
  loadProjectTree,
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
  let projectValues = eqAny(purchase.projectId, filters.projectId);
  if (selectedProjectIds.length > 0 && filters.includeSubProjects) {
    const { childrenByParent } = await loadProjectTree(db);
    projectValues = inArray(
      purchase.projectId,
      uniq(
        selectedProjectIds.flatMap((id) => [
          id,
          ...collectDescendantIds(childrenByParent, id),
        ]),
      ),
    );
  }
  // The `(none)` / `Has project` sentinels OR with that selection instead of
  // ANDing against it, so "Kitchen or unassigned" is one filter. The
  // unassigned-spend worklist is just `projectPresenceFilter: "none"` with no
  // `projectId`. (This replaced a `noProject` boolean that AND-ed, which is
  // why the Unassigned view had to clobber `projectId` to avoid matching
  // nothing at all.)
  const projectCondition = or(
    projectValues,
    presenceCondition(purchase.projectId, filters.projectPresenceFilter),
  );

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
      // productId still set and productName null; see dbPurchaseToAPI). The
      // same column-null-only rule applies to the project presence above: a
      // purchase whose project was soft-deleted is NOT "(none)".
      presenceCondition(purchase.productId, filters.productPresenceFilter),
      // Exact, not ILIKE: the control is a picklist over the `vendorOptions`
      // roster below, so a substring match let one option's count disagree with
      // the rows it returned. `(none)` ORs in, same rule as project above.
      eqAnyOrPresence(
        purchase.vendor,
        filters.vendor,
        filters.vendorPresenceFilter,
      ),
      filters.future !== undefined
        ? eq(purchase.future, filters.future)
        : undefined,
      // Rows with a null `date` (common on `future` purchases — nothing to
      // date yet) fall out of any date window by plain SQL comparison
      // semantics; that's intended, not a bug to work around.
      filters.dateFrom ? gte(purchase.date, filters.dateFrom) : undefined,
      filters.dateTo ? lte(purchase.date, filters.dateTo) : undefined,
      presenceCondition(purchase.cost, filters.costPresenceFilter),
      presenceCondition(purchase.orderId, filters.orderIdPresenceFilter),
      // Exact, like vendor above — an order id is an identifier, not a search
      // term. ANDs with the vendor condition rather than ORing, which is what
      // makes `(vendor, orderId)` the strict group key `getPurchaseOrderSiblings`
      // relies on.
      eqAny(purchase.orderId, filters.orderId),
    ],
  );
};

/**
 * Distinct vendor roster + row counts, ranked by frequency (then
 * alphabetically) — feeds the ledger's Vendor filter picklist
 * (`purchase.vendorOptions`). Modeled on `projectNameOptions`
 * (repo/project/lookup.ts): a single indexed query, no rollup/dependency
 * joins. Unlike that one, vendor is free text on `purchase` itself rather
 * than a joined entity, so this groups instead of selecting distinct rows.
 */
export const purchaseVendorOptions = async (
  db: Database,
): Promise<PurchaseVendorOptionsOut> => {
  const rows = await getDb(db)
    .select({ vendor: purchase.vendor, count: count() })
    .from(purchase)
    .where(and(notDeleted(purchase), isNotNull(purchase.vendor)))
    .groupBy(purchase.vendor)
    .orderBy(desc(count()), asc(purchase.vendor));
  // `isNotNull` already filtered nulls out in SQL; narrow the type rather than
  // casting, same convention as the `rawLine` narrowing in problems/reparse.ts.
  return rows.flatMap((row) =>
    row.vendor ? [{ vendor: row.vendor, count: row.count }] : [],
  );
};

/**
 * The other purchases from this purchase's order — the "Same Order" section.
 *
 * Deliberately routed through `purchaseList` rather than its own SELECT: this
 * section and the `?order=…&vendor=…` ledger link its header points at must
 * show the same rows, and they do so by construction when both resolve through
 * `buildPurchaseWhereClause`. It also inherits `dbPurchaseToAPI` and the live
 * project/product name resolution for free.
 *
 * Strict `(vendor, orderId)`: a null vendor forms its own group, expressed as
 * `vendorPresenceFilter: "none"` so it runs through `eqAnyOrPresence` like
 * every other vendor predicate rather than a bespoke IS NULL. An order whose
 * rows disagree on vendor therefore splits in two — that drift is real (vendor
 * was backfilled separately from orderId), which is what
 * `findOrdersWithPartialVendor` sweeps for.
 *
 * The 100 cap is not pagination: the largest real order is a handful of rows
 * (a 6-line Amazon order, a buy/return pair), so a page-2 affordance would be
 * dead UI. The ledger link is the escape hatch if that ever stops holding.
 */
export const getPurchaseOrderSiblings = async (
  db: Database,
  id: PurchaseId,
): Promise<PurchaseOut[]> => {
  const [source] = await getDb(db)
    .select({ vendor: purchase.vendor, orderId: purchase.orderId })
    .from(purchase)
    .where(and(eq(purchase.id, id), notDeleted(purchase)))
    .limit(1);

  if (!source?.orderId) return [];

  const { data } = await purchaseList(
    db,
    {
      orderId: source.orderId,
      ...(source.vendor
        ? { vendor: source.vendor }
        : { vendorPresenceFilter: "none" as const }),
    },
    [{ orderBy: "date", direction: "asc" }],
    { pageIndex: 0, pageSize: 100 },
  );

  return data.filter((row) => row.id !== id);
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
