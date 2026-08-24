import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { unsafeProjectId } from "@cubby/schemas/identifiers";
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
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { expense, purchase } from "~/server/db/schema";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  rangeConditions,
  relations,
} from "~/server/repo/database-helpers";
import { disposalPurchaseIds } from "~/server/repo/product/ownership";
import { matchingEmbeddedProjectIds } from "~/server/repo/project/dashboard-shared";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { dbExpenseToAPI } from "./helpers";

/**
 * Resolve a batch of shortcodes to their (unbranded) uuids for use in a WHERE
 * clause. Unknown/malformed codes simply drop out — a filter naming a code
 * that doesn't exist should match nothing, not throw. The `entity` parameter
 * pins the expected type so a wrong-prefix code is silently dropped rather than
 * matching an unrelated row.
 *
 * `resolveAllPresent` applies the same live-row semantics as the list itself,
 * including canonical/legacy shortcode normalization.
 */
const toUuids = async (
  db: Database,
  codes: readonly string[],
  entity: ShortcodeEntity,
): Promise<string[]> => {
  return resolveAllPresent(db, entity, codes);
};

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
 * `notDeleted(purchase)` is mandatory: a soft-deleted Purchase is still a row, so
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

export const chargeCondition = (
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
 * scope expense rows. Shared by `expenseList` (the ledger), `expenseAnalytics`
 * (repo/expense/analytics.ts), and `projectPortfolioAnalytics`
 * (repo/project/portfolio-analytics.ts) so all three can never drift under the
 * same filter set — the plan's hard invariant is "ledger totals and analytics
 * totals always agree".
 *
 * `extraConditions` is an escape hatch for a caller that already has a
 * predicate the `ExpenseFilters` vocabulary can't express — e.g.
 * `projectPortfolioAnalytics` already holds resolved project **uuids** (not
 * the shortcodes `filters.projectId` expects), so it ANDs an `inArray`
 * straight onto the result instead of round-tripping uuids back to
 * shortcodes just to satisfy `toUuids`.
 */
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
  options?: { extraConditions?: Array<SQL | undefined> },
): Promise<SQL | undefined> => {
  // When scoped to a project subtree, resolve each selected project + every
  // live descendant and match on the whole set; otherwise a plain match on the
  // selection (one project or several — see `eqAny`). Filters arrive as
  // shortcodes, resolved to the uuid FK the column actually stores.
  const selectedProjectCodes = filters.projectId
    ? [filters.projectId].flat()
    : [];
  const selectedProjectIds = await toUuids(db, selectedProjectCodes, "project");
  let projectValues =
    selectedProjectIds.length > 0
      ? eqAny(expense.projectId, selectedProjectIds)
      : selectedProjectCodes.length > 0
        ? sql`false`
        : undefined;
  if (selectedProjectIds.length > 0 && filters.includeSubProjects) {
    const { childrenByParent } = await loadProjectTree(db);
    projectValues = inArray(
      expense.projectId,
      uniq(
        selectedProjectIds.flatMap((id) => {
          const projectId = unsafeProjectId(id);
          return [
            projectId,
            ...collectDescendantIds(childrenByParent, projectId),
          ];
        }),
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
  const scopedProjectIds = filters.projectScope
    ? await matchingEmbeddedProjectIds(db, filters.projectScope)
    : null;

  // `search` matches the expense NAME only, and its terms OR. It is passed as
  // an extra condition rather than a `searchFilters` entry because
  // buildSearchConditions ANDs those — which is right for `notesSearch` and
  // `urlSearch` below (distinct filters, meant to narrow) but wrong within one
  // multi-term name search, where the caller is guessing at synonyms for a row
  // that names the thing rather than the product (`dust extractor` for a
  // Festool vacuum). The search document builder uses the same pattern.
  //
  // `formatSearchTerm` returns undefined for an empty/whitespace term, so `or()`
  // degrades cleanly to undefined when every term is blank.
  const nameSearch = or(
    ...[filters.search ?? []]
      .flat()
      .map((term) => formatSearchTerm(expense.name, term)),
  );

  // Resolved once up front, same as `selectedProjectIds` above.
  const vendorUuids = await toUuids(
    db,
    filters.vendorId ? [filters.vendorId].flat() : [],
    "vendor",
  );
  const purchaseUuids = await toUuids(
    db,
    filters.purchaseId ? [filters.purchaseId].flat() : [],
    "purchase",
  );
  const productUuids = await toUuids(
    db,
    filters.productId ? [filters.productId] : [],
    "product",
  );

  // `notesSearch`/`urlSearch` DO belong in searchFilters: they are separate
  // filters and ANDing them with each other and with the name search is the
  // intended semantics. What must never happen is a second entry reusing
  // `filters.search` itself — that would mean `name ILIKE q AND notes ILIKE q`,
  // and most rows have no notes, which would silently zero out expense search.
  return buildSearchConditions(
    expense,
    [
      { column: expense.notes, term: filters.notesSearch },
      { column: expense.url, term: filters.urlSearch },
    ],
    [
      ...auditDateWhereConditions(expense, filters),
      ...relatedWhereConditions("expense", filters, expense.id),
      ...(options?.extraConditions ?? []),
      nameSearch,
      eqAny(expense.lineKind, filters.lineKind),
      // A plain column, deliberately: `lineBasis` lives on Expense rather than
      // Purchase because allocation siblings routinely span separate Purchase
      // rows (drywall 1/3, 2/3, 3/3 are three Purchases; so are the countertop
      // deposit and balance). That also keeps this out of `chargeCondition`,
      // so the 193 purchase-less rows need no `isNull(purchaseId)` arm here.
      eqAny(expense.lineBasis, filters.lineBasis),
      eqAny(expense.costType, filters.costType),
      eqAny(expense.trade, filters.trade),
      projectCondition,
      scopedProjectIds
        ? scopedProjectIds.length > 0
          ? inArray(expense.projectId, scopedProjectIds)
          : sql`false`
        : undefined,
      // `productUuids.length === 0` is ambiguous by itself — it means either
      // "no productId filter was supplied" (no constraint) or "a productId WAS
      // supplied but didn't resolve to a live product" (must match nothing).
      // `eqAny([])` can't tell those apart (it always drops the condition, by
      // design — see its doc in database-helpers/query.ts), so the requested-
      // but-unresolved case is handled explicitly here, same as
      // `selectedProjectIds`/`scopedProjectIds` above.
      productUuids.length > 0
        ? eqAny(expense.productId, productUuids)
        : filters.productId
          ? sql`false`
          : undefined,
      // "linked" means productId IS NOT NULL — this deliberately includes
      // expenses whose product was later soft-deleted (those read back with
      // productId still set and productName null; see dbExpenseToAPI). The
      // same column-null-only rule applies to the project presence above: a
      // expense whose project was soft-deleted is NOT "(none)".
      presenceCondition(expense.productId, filters.productPresenceFilter),
      // Vendor is a joined entity now, so this matches vendor IDS through the
      // charge instead of an exact string on the row. `(none)` still ORs in, same
      // rule as project above — and because `purchase.vendorId` is NOT NULL, "no
      // vendor" and "no Purchase" are one predicate: `purchaseId IS NULL`.
      //
      // Same requested-but-unresolved handling as `productId` above: a
      // `filters.vendorId` that resolved to nothing contributes `sql\`false\``
      // to the OR (not `undefined`, which would drop the vendor half entirely
      // and let the presence filter alone decide — or, with no presence filter
      // either, let the whole condition vanish and match every row).
      or(
        filters.vendorId
          ? vendorUuids.length > 0
            ? chargeCondition(db, eqAny(purchase.vendorId, vendorUuids))
            : sql`false`
          : undefined,
        presenceCondition(expense.purchaseId, filters.vendorPresenceFilter),
      ),
      filters.future !== undefined
        ? eq(expense.future, filters.future)
        : undefined,
      // `expense.date` is NOT NULL (since #553 enforced the finance
      // invariants), so unlike `cost` below there is no null-row case to
      // reason about here — every row lands inside or outside the window.
      filters.dateFrom ? gte(expense.date, filters.dateFrom) : undefined,
      filters.dateTo ? lte(expense.date, filters.dateTo) : undefined,
      filters.dateRelative === "beforeToday"
        ? lt(expense.date, householdLocalDate())
        : filters.dateRelative === "onOrBeforeToday"
          ? lte(expense.date, householdLocalDate())
          : undefined,
      // `!== undefined`, NOT the truthiness guard the two date lines above use.
      // `costMin: 0` is a meaningful bound ("actuals and credits, no free
      // items") and `costMax: 0` is the credits-only worklist — a truthiness
      // check would silently drop both. Follows `future`'s guard style instead.
      //
      // `cost` IS nullable — `cost IS NULL` is the Unclassified predicate — and
      // those rows fall out of either bound by plain SQL comparison semantics;
      // that's intended. `costPresenceFilter: "none"` is the filter for
      // "no cost recorded".
      ...rangeConditions(expense.cost, filters, "cost"),
      presenceCondition(expense.cost, filters.costPresenceFilter),
      filters.costSign === "negative" ? lt(expense.cost, 0) : undefined,
      filters.costSign === "positive" ? gt(expense.cost, 0) : undefined,
      filters.disposalPurchasePresenceFilter === "has"
        ? inArray(expense.purchaseId, disposalPurchaseIds(getDb(db)))
        : filters.disposalPurchasePresenceFilter === "none"
          ? or(
              isNull(expense.purchaseId),
              notInArray(expense.purchaseId, disposalPurchaseIds(getDb(db))),
            )
          : undefined,
      // Quantity is nullable evidence, never an inferred one-unit default.
      // Bounds naturally exclude unknown rows; the presence filter is the
      // explicit worklist for those receipts.
      ...rangeConditions(expense.productQuantity, filters, "productQuantity"),
      presenceCondition(
        expense.productQuantity,
        filters.productQuantityPresenceFilter,
      ),
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
      // Unlike `vendorId`/`orderId` above, `purchaseId` IS the column on
      // `expense` — no `chargeCondition` sub-select hop needed. Same
      // requested-but-unresolved handling as `productId`/`vendorId` above.
      purchaseUuids.length > 0
        ? eqAny(expense.purchaseId, purchaseUuids)
        : filters.purchaseId
          ? sql`false`
          : undefined,
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
  readIntent: ListReadIntent = "page",
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

  const { data: rows, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db).query.expense.findMany({
        where: whereClause,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        ...relations.expense.withProject,
      }),
    count: () => countWhere(db, expense, whereClause),
  });

  return { data: rows.map(dbExpenseToAPI), count };
};
