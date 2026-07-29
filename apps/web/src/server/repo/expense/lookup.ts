import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { expenseSortableFields } from "@cubby/schemas/project";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { expense, purchase } from "~/server/db/schema";
import {
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
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
import { dbExpenseToAPI } from "./helpers";

/**
 * Lift a predicate on the CHARGE into a predicate on the expense.
 *
 * An **uncorrelated `IN` sub-select**, deliberately NOT a correlated `EXISTS`.
 * `expenseList` runs through the relational query builder
 * (`query.expense.findMany`), which aliases the root table as `"expense"` but
 * does NOT rewrite column refs inside a sub-select — so a correlated
 * `EXISTS (… WHERE purchase.id = expense.purchaseId)` emits a dangling
 * `"Expense"."purchaseId"` that isn't in scope. Same trap as `idSetPresence` and
 * the non-recursive project date filters (see repo/project/dashboard-shared.ts).
 * Here `expense.purchaseId` is referenced from the OUTER query, where the alias
 * is applied correctly, and the sub-select stands alone.
 *
 * `notDeleted(purchase)` is mandatory: a soft-deleted charge is still a row, so
 * without it an expense whose charge was deleted would keep matching its old
 * vendor. Same class of bug as the one that made `findOrphanedProducts` miss 18
 * of 20 real hits (#428).
 *
 * Returns undefined when the caller's inner predicate is undefined, so an unset
 * filter contributes nothing rather than an always-true constraint.
 */
const chargeIdsWhere = (db: Database, inner: SQL) =>
  getDb(db)
    .select({ id: purchase.id })
    .from(purchase)
    .where(and(notDeleted(purchase), inner));

const chargeCondition = (
  db: Database,
  inner: SQL | undefined,
): SQL | undefined =>
  inner === undefined
    ? undefined
    : inArray(expense.purchaseId, chargeIdsWhere(db, inner));

/**
 * "Has / has no order id", resolved through the charge.
 *
 * `"none"` folds TWO states: a row with no charge at all, and a row whose charge
 * simply never got an order id (a contractor's progress payment). Both have no
 * order id, which is what this filter has always meant.
 *
 * The `isNull` arm is load-bearing, not defensive: `NOT IN (…)` evaluates to NULL
 * — and so fails to match — when the left side is NULL, so a `notInArray` alone
 * would silently drop every charge-less row from the "none" bucket. That's 193
 * rows on the real ledger.
 */
const orderIdPresence = (
  db: Database,
  presence: ExpenseFilters["orderIdPresenceFilter"],
): SQL | undefined => {
  if (presence === undefined) return undefined;
  const withOrderId = chargeIdsWhere(db, isNotNull(purchase.orderId));
  return presence === "has"
    ? inArray(expense.purchaseId, withOrderId)
    : or(
        isNull(expense.purchaseId),
        notInArray(expense.purchaseId, withOrderId),
      );
};

/**
 * Translate `ExpenseFilters` into the exact Drizzle WHERE clause used to
 * scope expense rows. Shared by `expenseList` (the ledger) and
 * `expenseAnalytics` (repo/expense/analytics.ts) so the two can never
 * drift under the same filter set — the plan's hard invariant is "ledger
 * totals and analytics totals always agree".
 */
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<SQL | undefined> => {
  // When scoped to a project subtree, resolve each selected project + every
  // live descendant and match on the whole set; otherwise a plain match on the
  // selection (one project or several — see `eqAny`).
  const selectedProjectIds = filters.projectId
    ? [filters.projectId].flat()
    : [];
  let projectValues = eqAny(expense.projectId, filters.projectId);
  if (selectedProjectIds.length > 0 && filters.includeSubProjects) {
    const { childrenByParent } = await loadProjectTree(db);
    projectValues = inArray(
      expense.projectId,
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
    presenceCondition(expense.projectId, filters.projectPresenceFilter),
  );

  // `search` stays a single-column term: buildSearchConditions ANDs its
  // searchFilters entries, so adding `{ column: vendor, term: filters.search }`
  // here would mean `name ILIKE q AND vendor ILIKE q` — and vendor is null on
  // nearly every row, which would silently zero out expense search. Vendor
  // matching is its own filter, applied below.
  return buildSearchConditions(
    expense,
    [{ column: expense.name, term: filters.search }],
    [
      eqAny(expense.costType, filters.costType),
      eqAny(expense.trade, filters.trade),
      projectCondition,
      eqAny(expense.productId, filters.productId),
      // "linked" means productId IS NOT NULL — this deliberately includes
      // expenses whose product was later soft-deleted (those read back with
      // productId still set and productName null; see dbExpenseToAPI). The
      // same column-null-only rule applies to the project presence above: a
      // expense whose project was soft-deleted is NOT "(none)".
      presenceCondition(expense.productId, filters.productPresenceFilter),
      // Vendor is a joined entity now, so this matches vendor IDS through the
      // charge instead of an exact string on the row. `(none)` still ORs in, same
      // rule as project above — and because `purchase.vendorId` is NOT NULL, "no
      // vendor" and "no charge" are one predicate: `purchaseId IS NULL`.
      or(
        chargeCondition(db, eqAny(purchase.vendorId, filters.vendorId)),
        presenceCondition(expense.purchaseId, filters.vendorPresenceFilter),
      ),
      filters.future !== undefined
        ? eq(expense.future, filters.future)
        : undefined,
      // Rows with a null `date` (common on `future` expenses — nothing to
      // date yet) fall out of any date window by plain SQL comparison
      // semantics; that's intended, not a bug to work around.
      filters.dateFrom ? gte(expense.date, filters.dateFrom) : undefined,
      filters.dateTo ? lte(expense.date, filters.dateTo) : undefined,
      presenceCondition(expense.cost, filters.costPresenceFilter),
      // `orderId` presence can't be a column-null check any more: it's a column
      // on the CHARGE, and a row with a charge that has no order id is a
      // different state from a row with no charge at all. Both read as "no order
      // id" here, which is what the filter has always meant.
      orderIdPresence(db, filters.orderIdPresenceFilter),
      // Exact, not a substring — an order id is an identifier, not a search term.
      // No longer needs pairing with a vendor to be a safe group key: it resolves
      // through `purchaseId`, and `(vendorId, orderId)` is partial-unique, so a
      // short id like Tool Nirvana's "#11325" can't drag in another retailer's.
      chargeCondition(db, eqAny(purchase.orderId, filters.orderId)),
    ],
  );
};

/**
 * Sorts the generic column path can't produce: the joined project/product names
 * shown in those columns aren't columns on `expense`, and neither are `vendor`
 * and `orderId` any more — both live on the charge.
 *
 * Correlated subqueries rather than joins so `expenseList` stays a relational
 * `findMany` (its count query is then untouched). The soft-delete guard mirrors
 * what `resolveLiveJoinName` applies on read, so an expense whose project,
 * product or charge was deleted sorts as null — the same way it renders.
 *
 * NULLS LAST in both directions is the house convention (see `buildOrderBy`).
 * `trade` needs no entry: it's a plain text column, so it falls through to the
 * generic path and sorts alphabetically.
 */
const resolveExpenseSort = (sort: SortParams) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";

  if (sort.orderBy === "project") {
    return [
      sql.raw(
        `(SELECT p."name" FROM "Project" p ` +
          `WHERE p."id" = "expense"."projectId" AND p."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "product") {
    return [
      sql.raw(
        `(SELECT pr."name" FROM "Product" pr ` +
          `WHERE pr."id" = "expense"."productId" AND pr."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  // Both hop expense → Purchase → Vendor. The `deletedAt IS NULL` guards on each
  // hop are what keep a soft-deleted charge from sorting under its old vendor.
  if (sort.orderBy === "vendor") {
    return [
      sql.raw(
        `(SELECT v."name" FROM "Purchase" pu ` +
          `JOIN "Vendor" v ON v."id" = pu."vendorId" AND v."deletedAt" IS NULL ` +
          `WHERE pu."id" = "expense"."purchaseId" AND pu."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  if (sort.orderBy === "orderId") {
    return [
      sql.raw(
        `(SELECT pu."orderId" FROM "Purchase" pu ` +
          `WHERE pu."id" = "expense"."purchaseId" AND pu."deletedAt" IS NULL) ${dirSql}`,
      ),
    ];
  }

  return null;
};

export const expenseList = async (
  db: Database,
  filters: ExpenseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: ExpenseOut[]; count: number }> => {
  const whereClause = await buildExpenseWhereClause(db, filters);

  const orderByArray = buildOrderBy(
    expense,
    sorts,
    [...expenseSortableFields],
    {
      resolve: resolveExpenseSort,
    },
  );
  const { take, skip } = buildTakeSkip(pagination);

  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db).query.expense.findMany({
      where: whereClause,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
      ...relations.expense.withProject,
    }),
    countWhere(db, expense, whereClause),
  );

  return { data: rows.map(dbExpenseToAPI), count };
};
