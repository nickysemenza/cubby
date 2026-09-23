import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ExpenseFilters,
  ExpenseListItemOut,
} from "@cubby/schemas/project";
import {
  and,
  gt,
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
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  relations,
  shortcodeSetCondition,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import { disposalPurchaseIds } from "~/server/repo/product/ownership";
import { matchingEmbeddedProjectIds } from "~/server/repo/project/dashboard-shared";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/repo/project/subtree";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";

import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
  expenseInheritanceReadExtras,
} from "../expense-inheritance";
import {
  type ExpenseAllocationProjectScope,
  expenseAllocationExistsSql,
  loadExpenseProjectAllocations,
} from "../expense-project-allocation";
import { dbExpenseToAPI } from "./helpers";

const effectiveTrade = effectiveExpenseTradeSql('"Expense"');

// Drop malformed, missing, soft-deleted, and wrong-prefix references.
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
 * Effective-trade filter as an uncorrelated `IN` sub-select, for the same
 * reason as `chargeCondition` above: `effectiveExpenseTradeSql` spells its
 * outer-row references as raw `"Expense"."…"`, which the relational builder
 * cannot rewrite to its `"expense"` alias. Inside a standalone
 * `select … from "Expense"` the raw name binds to the sub-select's own FROM,
 * and the only outer reference is `expense.id`, a top-level column every
 * builder aliases correctly. (CUBBY-11R: the list leg threw
 * `invalid reference to FROM-clause entry for table "Expense"`.)
 *
 * An empty requested set is "no constraint", matching `eqAny`.
 */
const tradeCondition = (
  db: Database,
  trades: ExpenseFilters["trade"],
): SQL | undefined => {
  const values = trades === undefined ? [] : [trades].flat();
  if (values.length === 0) return undefined;
  return inArray(
    expense.id,
    getDb(db)
      .select({ id: expense.id })
      .from(expense)
      .where(and(notDeleted(expense), inArray(effectiveTrade, values))),
  );
};

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

export const resolveExpenseProjectAllocationScope = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseAllocationProjectScope | undefined> => {
  const codes = filters.projectId ? [filters.projectId].flat() : [];
  const ids = await toUuids(db, codes, "project");
  let selectedIds = ids;
  if (ids.length > 0 && filters.includeSubProjects) {
    const { childrenByParent } = await loadProjectTree(db);
    selectedIds = uniq(
      ids.flatMap((id) => {
        const projectId = parseEntityId("project", id);
        return [
          projectId,
          ...collectDescendantIds(childrenByParent, projectId),
        ];
      }),
    );
  }
  if (codes.length > 0 && selectedIds.length === 0) {
    return { projectIds: [] };
  }
  const projectIds = selectedIds.map((id) => parseEntityId("project", id));
  if (projectIds.length === 0 && !filters.projectPresenceFilter)
    return undefined;
  return {
    projectIds: projectIds.length > 0 ? projectIds : undefined,
    presence: filters.projectPresenceFilter,
  };
};

const projectFilterCondition = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<SQL | undefined> => {
  const scope = await resolveExpenseProjectAllocationScope(db, filters);
  if (!scope) return undefined;
  // The presence sentinel ORs with the selected projects, so "Kitchen or
  // unassigned" remains one filter rather than an impossible conjunction.
  return expenseAllocationExistsSql(sql`${expense.id}`, scope);
};

const requestedReferenceCondition = (
  column: typeof expense.productId | typeof expense.purchaseId,
  requested: boolean,
  ids: string[],
): SQL | undefined => {
  if (ids.length > 0) return eqAny(column, ids);
  return requested ? sql`false` : undefined;
};

const vendorFilterCondition = (
  db: Database,
  filters: ExpenseFilters,
  vendorIds: string[],
): SQL | undefined =>
  or(
    filters.vendorId
      ? vendorIds.length > 0
        ? chargeCondition(db, eqAny(purchase.vendorId, vendorIds))
        : sql`false`
      : undefined,
    presenceCondition(expense.purchaseId, filters.vendorPresenceFilter),
  );

const relativeDateCondition = (
  relative: ExpenseFilters["dateRelative"],
): SQL | undefined => {
  if (relative === "beforeToday") {
    return lt(expense.date, householdLocalDate());
  }
  if (relative === "onOrBeforeToday") {
    return lte(expense.date, householdLocalDate());
  }
  return undefined;
};

const disposalPurchaseCondition = (
  db: Database,
  presence: ExpenseFilters["disposalPurchasePresenceFilter"],
): SQL | undefined => {
  if (presence === "has") {
    return inArray(expense.purchaseId, disposalPurchaseIds(getDb(db)));
  }
  if (presence === "none") {
    return or(
      isNull(expense.purchaseId),
      notInArray(expense.purchaseId, disposalPurchaseIds(getDb(db))),
    );
  }
  return undefined;
};

const loadExpenseFilterReferences = async (
  db: Database,
  filters: ExpenseFilters,
) => {
  // Keep these sequential: callers may supply a transaction-backed Database.
  const vendorIds = await toUuids(
    db,
    filters.vendorId ? [filters.vendorId].flat() : [],
    "vendor",
  );
  const purchaseIds = await toUuids(
    db,
    filters.purchaseId ? [filters.purchaseId].flat() : [],
    "purchase",
  );
  const productIds = await toUuids(
    db,
    filters.productId ? [filters.productId] : [],
    "product",
  );
  return { vendorIds, purchaseIds, productIds };
};

const expenseScaffold = listScaffold("expense", expense);

// Shared by list and analytics so identical filter sets produce identical totals.
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
  options?: { extraConditions?: Array<SQL | undefined> },
): Promise<SQL | undefined> => {
  const projectCondition = await projectFilterCondition(db, filters);
  // The `(none)` / `Has project` sentinels OR with that selection instead of
  // ANDing against it, so "Kitchen or unassigned" is one filter. The
  // unassigned-spend worklist is just `projectPresenceFilter: "none"` with no
  // `projectId`. (This replaced a `noProject` boolean that AND-ed, which is
  // why the Unassigned view had to clobber `projectId` to avoid matching
  // nothing at all.)
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

  const { vendorIds, purchaseIds, productIds } =
    await loadExpenseFilterReferences(db, filters);

  // `notesSearch`/`urlSearch` are declared stored filters of their own, ANDed
  // with the name search. What must never happen is a predicate reusing
  // `filters.search` over notes — most rows have no notes, which would
  // silently zero out expense search.
  //
  // `lineKind`, `lineBasis`, `costType` (multiselect) and `future` (boolean)
  // are also declared stored filters — applied by `expenseScaffold.where`
  // before the conditions below. `trade` is stripped from `storedFilters`
  // (below) and applied instead by `tradeCondition`, an uncorrelated
  // sub-select — see its doc above.
  const storedFilters = { ...filters, trade: undefined };
  return expenseScaffold.where(storedFilters, [
    ...auditDateWhereConditions(expense, filters),
    ...relatedWhereConditions("expense", filters, expense.id),
    filters.ledgerPartyId === undefined
      ? undefined
      : sql`EXISTS (
          SELECT 1
          FROM "ExpenseAttribution" ea
          JOIN "LedgerParty" lp ON lp."id" = ea."ledgerPartyId" AND lp."deletedAt" IS NULL
          WHERE ea."expenseId" = ${expense.id}
            AND ea."deletedAt" IS NULL
            AND ${shortcodeSetCondition(sql`lp."shortcode"`, filters.ledgerPartyId)})`,
    ...(options?.extraConditions ?? []),
    nameSearch,
    projectCondition,
    scopedProjectIds
      ? scopedProjectIds.length > 0
        ? expenseAllocationExistsSql(sql`${expense.id}`, {
            projectIds: scopedProjectIds.map((id) =>
              parseEntityId("project", id),
            ),
          })
        : sql`false`
      : undefined,
    // `productIds.length === 0` is ambiguous by itself — it means either
    // "no productId filter was supplied" (no constraint) or "a productId WAS
    // supplied but didn't resolve to a live product" (must match nothing).
    // `eqAny([])` can't tell those apart (it always drops the condition, by
    // design — see its doc in database-helpers/query.ts), so the requested-
    // but-unresolved case is handled explicitly here, same as
    // the project/reference conditions above.
    requestedReferenceCondition(
      expense.productId,
      filters.productId !== undefined,
      productIds,
    ),
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
    vendorFilterCondition(db, filters, vendorIds),
    relativeDateCondition(filters.dateRelative),
    // `date`, `cost` and `productQuantity` bounds are declared stored ranges
    // (`costMin: 0` / `costMax: 0` are meaningful, and the declared predicate
    // keys on `!== undefined`). `cost` IS nullable — `cost IS NULL` is the
    // Unclassified predicate — and those rows fall out of either bound by
    // plain SQL comparison semantics; `costPresenceFilter: "none"` is the
    // filter for "no cost recorded".
    presenceCondition(expense.cost, filters.costPresenceFilter),
    filters.costSign === "negative" ? lt(expense.cost, 0) : undefined,
    filters.costSign === "positive" ? gt(expense.cost, 0) : undefined,
    disposalPurchaseCondition(db, filters.disposalPurchasePresenceFilter),
    // Quantity is nullable evidence, never an inferred one-unit default.
    // Bounds naturally exclude unknown rows; the presence filter is the
    // explicit worklist for those receipts.
    presenceCondition(
      expense.productQuantity,
      filters.productQuantityPresenceFilter,
    ),
    tradeCondition(db, filters.trade),
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
    requestedReferenceCondition(
      expense.purchaseId,
      filters.purchaseId !== undefined,
      purchaseIds,
    ),
  ]);
};

// Joined-name sorts stay correlated so the relational count query is untouched.
const resolveExpenseSort = (sort: SortParams) => {
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";

  if (sort.orderBy === "project") {
    const direction =
      sort.direction === "asc" ? sql`asc nulls last` : sql`desc nulls last`;
    return [
      sql`(SELECT p."name" FROM "Project" p
          WHERE p."id" = ${effectiveExpenseProjectSql('"expense"')}
            AND p."deletedAt" IS NULL) ${direction}`,
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
): Promise<{ data: ExpenseListItemOut[]; count: number }> => {
  const whereClause = await buildExpenseWhereClause(db, filters);

  const orderByArray = expenseScaffold.orderBy(
    sorts,
    {
      resolve: resolveExpenseSort,
    },
    filters,
  );
  const { take, skip } = expenseScaffold.page(pagination);

  const { data: rows, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db).query.expense.findMany({
        where: whereClause,
        orderBy: orderByArray,
        limit: take,
        offset: skip,
        extras: expenseInheritanceReadExtras(),
        ...relations.expense.withProject,
      }),
    count: () => countWhere(db, expense, whereClause),
  });
  const [allocations, dataQualities] = await Promise.all([
    loadExpenseProjectAllocations(
      db,
      rows.map((row) => row.id),
    ),
    loadDataQualities(
      db,
      "expense",
      rows.map((row) => row.id),
    ),
  ]);
  const allocationsByExpense = new Map<
    (typeof rows)[number]["id"],
    typeof allocations
  >();
  for (const allocation of allocations) {
    const existing = allocationsByExpense.get(allocation.expenseId) ?? [];
    existing.push(allocation);
    allocationsByExpense.set(allocation.expenseId, existing);
  }

  return {
    data: await withDisplayImages(
      db,
      "expense",
      rows.map((row) => ({
        ...row,
        projectAllocations: allocationsByExpense.get(row.id) ?? [],
      })),
      // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
      (row) => dbExpenseToAPI(row, dataQualities.get(row.id)!),
    ),
    count,
  };
};
