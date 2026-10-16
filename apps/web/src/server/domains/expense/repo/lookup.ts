import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import { expenseListItemOut } from "@cubby/schemas/project";
import type { ExpenseFilters } from "@cubby/schemas/project";
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

import { projectListRows } from "~/entity/model/list-read-schema";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  anyOfCondition,
  eqAny,
  formatSearchTerm,
  getDb,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  relations,
  shortcodeSetCondition,
} from "~/server/db/helpers";
import { expense, purchase } from "~/server/db/schema";
import {
  expenseDerivedMembershipSql,
  expenseDerivedValueSql,
  expenseSelectionForWhere,
} from "~/server/domains/expense/repo/expense-derived-read";
import { disposalPurchaseIds } from "~/server/domains/product/repo/ownership";
import { matchingEmbeddedProjectIds } from "~/server/domains/project/repo/dashboard-shared";
import {
  collectDescendantIds,
  loadProjectTree,
} from "~/server/domains/project/repo/subtree";
import { withDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  declaredFilterPredicates,
  listScaffold,
} from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  loadListGroup,
  wantsListGroup,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { resolveAllPresent } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  effectiveExpenseProjectSql,
  expenseInheritanceReadExtras,
} from "./expense-inheritance";
import {
  type ExpenseAllocationProjectScope,
  type ExpenseIdSelection,
  loadExpenseProjectAllocations,
} from "./expense-project-allocation";
import { loadExpenseSpendingAllocations } from "./expense-spending-allocation";
import { dbExpenseToAPI } from "./helpers";

/** Lift a Purchase predicate into the Expense selection. Deleted purchases must
 * not let expenses match their former vendor or other charge attributes. */
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

export const resolveExpenseProjectAllocationScope = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseAllocationProjectScope | undefined> => {
  const codes = filters.projectId ? [filters.projectId].flat() : [];
  const ids = await resolveAllPresent(db, "project", codes);
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
  const categoryCodes = filters.spendingCategoryId
    ? [filters.spendingCategoryId].flat()
    : [];
  const categoryIds = await resolveAllPresent(
    db,
    "spendingCategory",
    categoryCodes,
  );
  const membershipProjectIds = filters.projectScope
    ? await matchingEmbeddedProjectIds(db, filters.projectScope)
    : undefined;
  // Trade and cost type follow the same per-share split as category: an
  // adjustment matches through the shares it allocates to its principals.
  const trades = filters.trade ? [filters.trade].flat() : [];
  const costTypes = filters.costType ? [filters.costType].flat() : [];
  if (
    projectIds.length === 0 &&
    !filters.projectPresenceFilter &&
    categoryCodes.length === 0 &&
    !filters.spendingCategoryPresenceFilter &&
    trades.length === 0 &&
    costTypes.length === 0 &&
    membershipProjectIds === undefined
  )
    return undefined;
  return {
    membershipProjectIds,
    projectIds: projectIds.length > 0 ? projectIds : undefined,
    presence: filters.projectPresenceFilter,
    spendingCategoryIds: categoryCodes.length
      ? categoryIds.map((id) => parseEntityId("spendingCategory", id))
      : undefined,
    categoryPresence: filters.spendingCategoryPresenceFilter,
    trades: trades.length ? trades : undefined,
    costTypes: costTypes.length ? costTypes : undefined,
  };
};

const projectFilterCondition = async (
  db: Database,
  filters: ExpenseFilters,
  expenseIds?: ExpenseIdSelection,
): Promise<SQL | undefined> => {
  const scope = await resolveExpenseProjectAllocationScope(db, filters);
  if (!scope) return undefined;
  return expenseDerivedMembershipSql(sql`${expense.id}`, scope, expenseIds);
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
): SQL | undefined =>
  anyOfCondition(relative, (value) =>
    value === "beforeToday"
      ? lt(expense.date, householdLocalDate())
      : lte(expense.date, householdLocalDate()),
  );

const disposalPurchaseCondition = (
  presence: ExpenseFilters["disposalPurchasePresenceFilter"],
): SQL | undefined => {
  if (presence === "has") {
    return inArray(expense.purchaseId, disposalPurchaseIds());
  }
  if (presence === "none") {
    return or(
      isNull(expense.purchaseId),
      notInArray(expense.purchaseId, disposalPurchaseIds()),
    );
  }
  return undefined;
};

const loadExpenseFilterReferences = async (
  db: Database,
  filters: ExpenseFilters,
) => {
  // Keep these sequential: callers may supply a transaction-backed Database.
  const vendorIds = await resolveAllPresent(
    db,
    "vendor",
    filters.vendorId ? [filters.vendorId].flat() : [],
  );
  const purchaseIds = await resolveAllPresent(
    db,
    "purchase",
    filters.purchaseId ? [filters.purchaseId].flat() : [],
  );
  const productIds = await resolveAllPresent(
    db,
    "product",
    oneOrManyValues(filters.productId) ?? [],
  );
  return { vendorIds, purchaseIds, productIds };
};

// Allocation-backed sorts use one grouped lookup and retain the plain root
// FROM; the product and purchase sorts compile from their declared paths.
const expenseScaffold = listScaffold("expense", expense, {
  derived: {
    spendingCategoryId: expenseDerivedValueSql(
      "spendingCategoryNames",
      sql`${expense.id}`,
    ),
    projectId: sql`(SELECT p."name" FROM "Project" p
      WHERE p."id" = ${effectiveExpenseProjectSql('"Expense"')}
        AND p."deletedAt" IS NULL)`,
  },
});

// Shared by list and analytics so identical filter sets produce identical totals.
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
  options?: {
    extraConditions?: Array<SQL | undefined>;
    projectScope?: ExpenseAllocationProjectScope;
  },
): Promise<SQL | undefined> => {
  // The `(none)` / `Has project` sentinels OR with that selection instead of
  // ANDing against it, so "Kitchen or unassigned" is one filter. The
  // unassigned-spend worklist is just `projectPresenceFilter: "none"` with no
  // `projectId`. (This replaced a `noProject` boolean that AND-ed, which is
  // why the Unassigned view had to clobber `projectId` to avoid matching
  // nothing at all.)

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
  // `lineKind`, `lineBasis` and `future` are declared stored filters, applied
  // by `expenseScaffold.where` before the conditions below. `trade`,
  // `costType` and spending category are stripped from `storedFilters` and
  // applied per allocation share by `projectFilterCondition`.
  const storedFilters = {
    ...filters,
    trade: undefined,
    costType: undefined,
    spendingCategoryId: undefined,
    spendingCategoryPresenceFilter: undefined,
  };
  const rowConditions: Array<SQL | undefined> = [
    filters.ledgerPartyId === undefined
      ? undefined
      : sql`EXISTS (
          SELECT 1
          FROM "ExpenseAttribution" ea
          JOIN "LedgerParty" lp ON lp."id" = ea."ledgerPartyId" AND lp."deletedAt" IS NULL
          WHERE ea."expenseId" = ${expense.id}
            AND ea."deletedAt" IS NULL
            AND ${shortcodeSetCondition(sql`lp."shortcode"`, filters.ledgerPartyId)})`,
    nameSearch,
    // `productIds.length === 0` is ambiguous by itself — it means either
    // "no productId filter was supplied" (no constraint) or "a productId WAS
    // supplied but didn't resolve to a live product" (must match nothing).
    // `eqAny([])` can't tell those apart (it always drops the condition, by
    // design — see its doc in db/helpers/query.ts), so the requested-
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
    anyOfCondition(filters.costSign, (sign) =>
      sign === "negative" ? lt(expense.cost, 0) : gt(expense.cost, 0),
    ),
    disposalPurchaseCondition(filters.disposalPurchasePresenceFilter),
    // Quantity is nullable evidence, never an inferred one-unit default.
    // Bounds naturally exclude unknown rows; the presence filter is the
    // explicit worklist for those receipts.
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
    requestedReferenceCondition(
      expense.purchaseId,
      filters.purchaseId !== undefined,
      purchaseIds,
    ),
  ];
  // Only independent stored predicates bound allocation inputs. Quality and
  // caller-supplied conditions may themselves depend on allocation evidence.
  const selectedWhere = and(
    ...declaredFilterPredicates("expense", expense, storedFilters),
    ...rowConditions,
  );
  const selectedIds = selectedWhere
    ? expenseSelectionForWhere(and(notDeleted(expense), selectedWhere))
    : undefined;
  const projectCondition =
    options && "projectScope" in options
      ? options.projectScope
        ? expenseDerivedMembershipSql(
            sql`${expense.id}`,
            options.projectScope,
            selectedIds,
          )
        : undefined
      : await projectFilterCondition(db, filters, selectedIds);
  return expenseScaffold.where(storedFilters, [
    ...rowConditions,
    ...(options?.extraConditions ?? []),
    projectCondition,
  ]);
};

export const expenseListRead = async (
  db: Database,
  filters: ExpenseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const where = await buildExpenseWhereClause(db, filters);
  const page = expenseScaffold.list(
    db,
    { filters, sorts, pagination, readIntent, projection },
    {
      where,
      load: (where) => loadExpensePage(db, where, projection),
      hydrate: (rows) => hydrateExpenseRows(db, rows, projection),
    },
  );
  if (readIntent !== "page" || projection.kind !== "full") return page;
  const [result, [sum]] = await Promise.all([
    page,
    expenseListSums(db, where).then((sums) => [sums]),
  ]);
  return { ...result, sums: { cost: sum?.cost ?? 0 } };
};

const loadExpensePage = (
  db: Database,
  where: SQL,
  projection: ListProjection,
) => {
  const references = wantsListGroup(projection, "relations");
  const derived = wantsListGroup(projection, "derived");
  const media = wantsListGroup(projection, "media");
  const declared = relations.expense.withProject.with;
  return getDb(db).query.expense.findMany({
    where,
    extras: references || derived ? expenseInheritanceReadExtras() : undefined,
    with: {
      project: references || derived ? declared.project : undefined,
      product: references ? declared.product : undefined,
      purchase: references || derived || media ? declared.purchase : undefined,
      attributions: references ? declared.attributions : undefined,
      sourceClaims: references ? declared.sourceClaims : undefined,
    },
  });
};

const hydrateExpenseRows = async (
  db: Database,
  rows: Awaited<ReturnType<typeof loadExpensePage>>,
  projection: ListProjection,
) => {
  if (projection.kind === "base")
    return projectListRows(
      "expense",
      rows.map((row) => ({ ...row, id: row.shortcode })),
      projection,
    );
  const [allocations, dataQualities, spendingAllocations] = await Promise.all([
    loadListGroup(projection, "relations", () =>
      loadExpenseProjectAllocations(
        db,
        rows.map((row) => row.id),
      ),
    ),
    loadListGroup(projection, "quality", () =>
      loadDataQualities(
        db,
        "expense",
        rows.map((row) => row.id),
      ),
    ),
    // Derived trade/cost-type resolutions read the same allocation shares.
    loadListGroup(projection, ["relations", "derived"], () =>
      loadExpenseSpendingAllocations(
        db,
        rows.map((row) => row.id),
      ),
    ),
  ]);
  const allocationsByExpense = new Map<
    (typeof rows)[number]["id"],
    NonNullable<typeof allocations>
  >();
  for (const allocation of allocations ?? []) {
    const existing = allocationsByExpense.get(allocation.expenseId) ?? [];
    existing.push(allocation);
    allocationsByExpense.set(allocation.expenseId, existing);
  }

  const selectedRows = rows.map((row) => {
    const purchase = row.purchase;
    if (purchase && !("vendor" in purchase))
      throw new Error("Expense vendor relation was not loaded");
    const attributions =
      row.attributions?.map((value) => {
        if (!("ledgerParty" in value))
          throw new Error("Expense attribution relation was not loaded");
        return value;
      }) ?? [];
    return {
      ...row,
      project: row.project ?? null,
      product: row.product ?? null,
      purchase: purchase ?? null,
      attributions,
      sourceClaims: row.sourceClaims ?? [],
      projectAllocations: allocationsByExpense.get(row.id) ?? [],
      spendingCategoryAllocations: spendingAllocations?.get(row.id),
    };
  });
  const mapRow = (row: (typeof selectedRows)[number]) =>
    dbExpenseToAPI(row, dataQualities?.get(row.id));
  const mapped = wantsListGroup(projection, "media")
    ? await withDisplayImages(db, "expense", selectedRows, mapRow)
    : selectedRows.map(mapRow);
  return projectListRows("expense", mapped, projection);
};

export const expenseList = completeListReader(
  expenseListItemOut,
  expenseListRead,
);
export const expenseListSummary = async (
  db: Database,
  filters: ExpenseFilters,
) => {
  const where = await buildExpenseWhereClause(db, filters);
  return expenseListSums(db, where);
};
const expenseListSums = async (db: Database, where: SQL | undefined) => {
  const [sum] = await getDb(db)
    .select({ cost: sql<number>`coalesce(sum(${expense.cost}),0)::float` })
    .from(expense)
    .where(where);
  return { cost: sum?.cost ?? 0 };
};
