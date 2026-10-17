import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { oneOrManyValues } from "@cubby/schemas/pagination";
import {
  expenseCostSign,
  expenseFiltersSchema,
  expenseListItemOut,
} from "@cubby/schemas/project";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { and, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { projectListRows } from "~/entity/model/list-read-schema";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import {
  getDb,
  isTransaction,
  type ListReadIntent,
  notDeleted,
  presenceCondition,
  relations,
  shortcodeSetCondition,
} from "~/server/db/helpers";
import { expense, purchase, spendingCategory } from "~/server/db/schema";
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
  ListContext,
  listPrepare,
  shortcodeIdsSql,
} from "~/server/generic/list/repo/field-compiler";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";
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

export const resolveExpenseProjectAllocationScope = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<ExpenseAllocationProjectScope | undefined> => {
  const codes = filters.projectId ? [filters.projectId].flat() : [];
  const ids = await resolveAllPresent(db, "project", codes);
  let selectedIds = ids;
  // The generated "Include sub-projects" toggle reads absent as on.
  if (ids.length > 0 && filters.includeSubProjects !== false) {
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
  const selectedCategoryIds = (
    await resolveAllPresent(db, "spendingCategory", categoryCodes)
  ).map((id) => parseEntityId("spendingCategory", id));
  const categoryIds =
    selectedCategoryIds.length > 0 &&
    filters.includeSubSpendingCategories !== false
      ? (
          await getDb(db)
            .select({ id: spendingCategory.id })
            .from(spendingCategory)
            .where(
              sql`${spendingCategory.id} IN ${hierarchyDescendantsSql("spendingCategory", selectedCategoryIds)}`,
            )
        ).map((row) => row.id)
      : selectedCategoryIds;
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
    spendingCategoryIds: categoryCodes.length ? categoryIds : undefined,
    categoryPresence: filters.spendingCategoryPresenceFilter,
    trades: trades.length ? trades : undefined,
    costTypes: costTypes.length ? costTypes : undefined,
  };
};

/**
 * The allocation filters: each matches the expense's allocation shares, so
 * together they select one membership, read once. Trade presence reads the
 * row's own column and stays.
 */
const allocationKeys = [
  "projectId",
  "projectPresenceFilter",
  "includeSubProjects",
  "spendingCategoryId",
  "spendingCategoryPresenceFilter",
  "includeSubSpendingCategories",
  "trade",
  "costType",
  "projectScope",
] as const;

const withoutAllocation = (filters: ExpenseFilters): ExpenseFilters => {
  const rest: Partial<ExpenseFilters> = { ...filters };
  for (const key of allocationKeys) delete rest[key];
  return rest;
};

/** The first allocation filter set, which applies the shared membership. */
const allocationLead = (filters: ExpenseFilters) =>
  (oneOrManyValues(filters.projectId)?.length ?? 0) > 0 ||
  filters.projectPresenceFilter !== undefined
    ? "projectFilter"
    : (oneOrManyValues(filters.spendingCategoryId)?.length ?? 0) > 0 ||
        filters.spendingCategoryPresenceFilter !== undefined
      ? "spendingCategoryFilter"
      : (oneOrManyValues(filters.trade)?.length ?? 0) > 0
        ? "tradeFilter"
        : (oneOrManyValues(filters.costType)?.length ?? 0) > 0
          ? "costTypeFilter"
          : filters.projectScope !== undefined
            ? "projectScope"
            : null;

/** The SQL of every declared non-allocation filter, by derived key. */
const rowDerived = {
  // The allocated spending categories' names.
  spendingCategoryId: expenseDerivedValueSql(
    "spendingCategoryNames",
    sql`${expense.id}`,
  ),
  projectId: sql`(SELECT p."name" FROM "Project" p
    WHERE p."id" = ${effectiveExpenseProjectSql('"Expense"')}
      AND p."deletedAt" IS NULL)`,
  costSign: sql`CASE WHEN ${expense.cost} < 0 THEN ${expenseCostSign.enum.negative}::text
    WHEN ${expense.cost} > 0 THEN ${expenseCostSign.enum.positive}::text END`,
  disposalPurchase: inArray(expense.purchaseId, disposalPurchaseIds()),
  dateRelative: ({ values }: { values: readonly string[] }) =>
    or(
      ...values.map((value) =>
        value === "beforeToday"
          ? lt(expense.date, householdLocalDate())
          : lte(expense.date, householdLocalDate()),
      ),
    ),
  ledgerPartyId: ({ values }: { values: readonly string[] }) => sql`EXISTS (
    SELECT 1 FROM "ExpenseAttribution" ea
    WHERE ea."expenseId" = ${expense.id}
      AND ea."deletedAt" IS NULL
      AND ea."ledgerPartyId" IN ${shortcodeIdsSql("ledgerParty", (shortcode) =>
        shortcodeSetCondition(shortcode, values),
      )})`,
};

/**
 * The expenses whose allocation shares match the filters' allocation scope.
 * Only the independent row filters bound the allocation inputs; quality and
 * related-view conditions may themselves depend on allocation evidence.
 */
const allocationMembership = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<SQL | undefined> => {
  const scope = await resolveExpenseProjectAllocationScope(db, filters);
  if (!scope) return undefined;
  const selected = and(
    ...declaredFilterPredicates(
      "expense",
      expense,
      { ...withoutAllocation(filters), tradePresenceFilter: undefined },
      { derived: rowDerived, context: ListContext.empty },
    ),
  );
  return expenseDerivedMembershipSql(
    sql`${expense.id}`,
    scope,
    selected
      ? expenseSelectionForWhere(and(notDeleted(expense), selected))
      : undefined,
  );
};

const allocation = listPrepare(async (db, values) => {
  // The project tree and embedded scope loaders read outside a transaction.
  if (isTransaction(db))
    throw new Error("Expense allocation filters cannot read in a transaction");
  const filters = expenseFiltersSchema.parse(values);
  return {
    lead: allocationLead(filters),
    membership: await allocationMembership(db, filters),
  };
});

/** An allocation filter applies the membership when it leads the set. */
const allocationFilter = (key: ReturnType<typeof allocationLead>) =>
  allocation.predicate(({ lead, membership }) =>
    lead === key ? membership : undefined,
  );

// Allocation-backed sorts use one grouped lookup and retain the plain root
// FROM; the product and purchase sorts compile from their declared paths.
const expenseScaffold = listScaffold("expense", expense, {
  derived: {
    ...rowDerived,
    projectFilter: allocationFilter("projectFilter"),
    spendingCategoryFilter: allocationFilter("spendingCategoryFilter"),
    costTypeFilter: allocationFilter("costTypeFilter"),
    // The presence half reads the row's own trade column.
    tradeFilter: allocation.predicate(({ lead, membership }, { presence }) =>
      and(
        lead === "tradeFilter" ? membership : undefined,
        presenceCondition(expense.trade, presence),
      ),
    ),
  },
});

/**
 * Shared by list and analytics so identical filter sets produce identical
 * totals. `omitAllocationScope` drops the allocation filters for analytics
 * that join the allocation shares themselves.
 */
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
  options?: { omitAllocationScope?: boolean; context?: ListContext },
): Promise<SQL | undefined> => {
  const selected = options?.omitAllocationScope
    ? withoutAllocation(filters)
    : filters;
  const context =
    options?.context ??
    (await expenseScaffold.context(db, {
      filters: selected,
      readIntent: "count",
    }));
  return and(
    expenseScaffold.where(selected, { context }),
    // A project page's embedded scope, when no allocation filter carries it.
    allocationLead(selected) === "projectScope"
      ? await allocationMembership(db, filters)
      : undefined,
  );
};

export const expenseListRead = async (
  db: Database,
  filters: ExpenseFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const request = { filters, sorts, pagination, readIntent, projection };
  // One context serves the where and the list, so the allocation membership
  // resolves once.
  const context = await expenseScaffold.context(db, request);
  const where = await buildExpenseWhereClause(db, filters, { context });
  const page = expenseScaffold.list(db, request, {
    context,
    where,
    load: (where) => loadExpensePage(db, where, projection),
    hydrate: (rows) => hydrateExpenseRows(db, rows, projection),
  });
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
