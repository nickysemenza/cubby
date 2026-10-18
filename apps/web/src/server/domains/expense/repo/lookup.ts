import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { expenseCostSign, expenseListItemOut } from "@cubby/schemas/project";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { and, inArray, type SQL, sql } from "drizzle-orm";

import { projectListRows } from "~/entity/model/list-read-schema";
import type { Database } from "~/server/db";
import {
  getDb,
  type ListReadIntent,
  notDeleted,
  relations,
} from "~/server/db/helpers";
import {
  expense,
  project,
  purchase,
  spendingCategory,
} from "~/server/db/schema";
import {
  expenseDerivedMembershipSql,
  expenseDerivedValueSql,
  expenseSelectionForWhere,
} from "~/server/domains/expense/repo/expense-derived-read";
import { disposalPurchaseIds } from "~/server/domains/product/repo/ownership";
import { matchingEmbeddedProjectIds } from "~/server/domains/project/repo/dashboard-shared";
import { withDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  ListContext,
  listFilterValues,
  type ListFilterValues,
  listPrepare,
} from "~/server/generic/list/repo/field-compiler";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";
import {
  declaredFilterPredicates,
  listScaffold,
  rowSetFilterKeys,
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
  expenseJointAllocationSql,
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
    selectedIds = (
      await getDb(db)
        .select({ id: project.id })
        .from(project)
        .where(
          sql`${project.id} IN ${hierarchyDescendantsSql(
            "project",
            ids.map((id) => parseEntityId("project", id)),
          )}`,
        )
    ).map((row) => row.id);
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
    codes.length === 0 &&
    !filters.projectPresenceFilter &&
    categoryCodes.length === 0 &&
    !filters.spendingCategoryPresenceFilter &&
    trades.length === 0 &&
    !filters.tradePresenceFilter &&
    costTypes.length === 0 &&
    !filters.costTypePresenceFilter &&
    membershipProjectIds === undefined
  )
    return undefined;
  return {
    membershipProjectIds,
    // Requested codes that resolve to nothing match no project, though No
    // project may still match beside them.
    projectIds: codes.length > 0 ? projectIds : undefined,
    presence: filters.projectPresenceFilter,
    spendingCategoryIds: categoryCodes.length ? categoryIds : undefined,
    categoryPresence: filters.spendingCategoryPresenceFilter,
    trades: trades.length ? trades : undefined,
    tradePresence: filters.tradePresenceFilter,
    costTypes: costTypes.length ? costTypes : undefined,
    costTypePresence: filters.costTypePresenceFilter,
  };
};

/** The SQL of every declared filter outside the allocation shares, by derived key. */
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
};

const shareKeys = new Set(rowSetFilterKeys("expense", "allocationShares"));
const readsShare = (values: ListFilterValues, terminal: string) =>
  rowSetFilterKeys("expense", "allocationShares", terminal).some(
    (key) => values[key] !== undefined,
  );

/**
 * The expenses the request's other row filters select, which bound the
 * allocation they are matched by. Quality and related-view conditions may
 * themselves depend on allocation evidence, so they never bound it.
 */
const allocationBound = (values: ListFilterValues): SQL | undefined => {
  const selected = and(
    ...declaredFilterPredicates(
      "expense",
      expense,
      Object.fromEntries(
        Object.entries(values).filter(([key]) => !shareKeys.has(key)),
      ),
      { derived: rowDerived, context: ListContext.empty },
    ),
  );
  return selected
    ? expenseSelectionForWhere(and(notDeleted(expense), selected)).select
    : undefined;
};

/**
 * The `allocationShares` row set: every share of the bounded expenses,
 * allocating only the dimensions the request filters by.
 */
const allocationShares = listPrepare(async (_db, values) => ({
  bound: allocationBound(values),
  projects: readsShare(values, "project"),
  categories: readsShare(values, "spendingCategory"),
  trades: readsShare(values, "trade"),
}));

// Allocation-backed sorts use one grouped lookup and retain the plain root
// FROM; the product and purchase sorts compile from their declared paths.
const expenseScaffold = listScaffold("expense", expense, {
  derived: rowDerived,
  rows: {
    allocationShares: allocationShares.rows(
      ({ bound, projects, categories, trades }) =>
        sql`SELECT share."expenseId" AS "owner", share."projectId" AS "project",
          share."spendingCategoryId" AS "spendingCategory", share.trade AS "trade",
          share."costType" AS "costType"
        FROM (${expenseJointAllocationSql(
          bound === undefined ? undefined : { select: bound },
          undefined,
          {
            projects,
            categories,
            trades: categories || trades,
            principals: false,
          },
        )}) share`,
    ),
  },
});

/**
 * A project page's embedded scope: expenses with any share in a project
 * the nested project filters select, bounded like the allocation filters.
 */
const embeddedProjectMembership = async (
  db: Database,
  filters: ExpenseFilters,
): Promise<SQL | undefined> => {
  if (filters.projectScope === undefined) return undefined;
  const bound = allocationBound(listFilterValues.parse(filters));
  return expenseDerivedMembershipSql(
    sql`${expense.id}`,
    {
      membershipProjectIds: await matchingEmbeddedProjectIds(
        db,
        filters.projectScope,
      ),
    },
    bound === undefined ? undefined : { select: bound },
  );
};

/**
 * The allocation filters an analytics scope (`resolveExpenseProjectAllocationScope`)
 * expresses itself: any-of values ORed with their presence, all on one share.
 */
const scopedAllocationKeys = new Set([
  "projectId",
  "projectPresenceFilter",
  "includeSubProjects",
  "spendingCategoryId",
  "spendingCategoryPresenceFilter",
  "includeSubSpendingCategories",
  "trade",
  "tradePresenceFilter",
  "costType",
  "costTypePresenceFilter",
]);

/**
 * The filters an analytics read selects expenses by. Its scope already
 * carries the embedded project scope and, when it expresses them, the
 * allocation filters, which then leave the where so the shares allocate
 * once. A key it cannot express (Match all, Exclude) keeps every allocation
 * filter in the where, so the read selects
 * the expenses the list does.
 */
const analyticsFilters = (filters: ExpenseFilters): ExpenseFilters => {
  const { projectScope: _embedded, ...rest } = filters;
  const values = listFilterValues.parse(rest);
  const unscoped = [...shareKeys].some(
    (key) => !scopedAllocationKeys.has(key) && values[key] !== undefined,
  );
  if (unscoped) return rest;
  const scoped: Partial<ExpenseFilters> = { ...rest };
  for (const key of shareKeys)
    if (Object.hasOwn(scoped, key)) Reflect.deleteProperty(scoped, key);
  return scoped;
};

/**
 * Shared by list and analytics so identical filter sets select identical
 * expenses. `omitAllocationScope` is for analytics that join the allocation
 * shares themselves (`analyticsFilters`).
 */
export const buildExpenseWhereClause = async (
  db: Database,
  filters: ExpenseFilters,
  options?: { omitAllocationScope?: boolean; context?: ListContext },
): Promise<SQL | undefined> => {
  const selected = options?.omitAllocationScope
    ? analyticsFilters(filters)
    : filters;
  const context =
    options?.context ??
    (await expenseScaffold.context(db, {
      filters: selected,
      readIntent: "count",
    }));
  return and(
    expenseScaffold.where(selected, { context }),
    await embeddedProjectMembership(db, selected),
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
