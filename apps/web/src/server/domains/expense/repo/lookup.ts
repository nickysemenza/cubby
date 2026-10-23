import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { expenseCostSign, expenseListItemOut } from "@cubby/schemas/project";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { and, inArray, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  type ListReadIntent,
  notDeleted,
  relations,
} from "~/server/db/helpers";
import { expense, project, spendingCategory } from "~/server/db/schema";
import {
  expenseDerivedValueSql,
  expenseSelectionForWhere,
} from "~/server/domains/expense/repo/expense-derived-read";
import { disposalPurchaseIds } from "~/server/domains/product/repo/ownership";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
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
  type ListReadOptions,
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
import {
  expenseRelationFields,
  expenseDerivedFields,
  expenseResolutionFields,
  expenseMediaFields,
} from "./helpers";

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
    !filters.costTypePresenceFilter
  )
    return undefined;
  return {
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
export const expenseScaffold = listScaffold("expense", expense, {
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
  scopes: { projectScope: () => projectScaffold },
});

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

// A related scope (the embedded project scope) selects whole expenses, as
// the list does, so it stays in an analytics where.
const filterShareKeys = [...shareKeys].filter(
  (key) => !Object.hasOwn(generatedEntityListFields.expense.scopes, key),
);

/**
 * The filters an analytics read selects expenses by. Its scope already
 * carries the allocation filters it expresses, which then leave the where so
 * the shares allocate once. A key it cannot express (Match all, Exclude)
 * keeps every allocation filter in the where, so the read selects the
 * expenses the list does.
 */
const analyticsFilters = (filters: ExpenseFilters): ExpenseFilters => {
  const values = listFilterValues.parse(filters);
  const unscoped = filterShareKeys.some(
    (key) => !scopedAllocationKeys.has(key) && values[key] !== undefined,
  );
  if (unscoped) return filters;
  const scoped: Partial<ExpenseFilters> = { ...filters };
  for (const key of filterShareKeys)
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
  options?: {
    omitAllocationScope?: boolean;
    context?: ListContext;
    readContext?: QualityReadContext;
  },
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
  // Standalone totals and callers with their own FROM supply no statement-local evidence.
  return expenseScaffold.where(selected, {
    context,
    readContext: options?.readContext ?? {},
  });
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
  const page = expenseScaffold.read(db, request, {
    context,
    where,
    load: (where) => loadExpensePage(db, where, projection),
    read: expenseRead(db),
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

type ExpenseListRow = Awaited<ReturnType<typeof loadExpensePage>>[number];
const expenseJoinedRow = (row: ExpenseListRow) => {
  if (row.purchase && !("vendor" in row.purchase))
    throw new Error("Expense vendor relation was not loaded");
  return {
    ...row,
    project: row.project ?? null,
    product: row.product ?? null,
    purchase: row.purchase ?? null,
  };
};
const expenseRead = (db: Database): ListReadOptions<ExpenseListRow> => ({
  media: true,
  bindings: (bind) => {
    const spending = bind.batch(({ rows }) =>
      loadExpenseSpendingAllocations(
        db,
        rows.map((row) => row.id),
      ),
    );
    const projects = bind.batch(async ({ rows }) => {
      const values = await loadExpenseProjectAllocations(
        db,
        rows.map((row) => row.id),
      );
      const byExpense = new Map<ExpenseListRow["id"], typeof values>();
      for (const value of values) {
        const group = byExpense.get(value.expenseId) ?? [];
        group.push(value);
        byExpense.set(value.expenseId, group);
      }
      return byExpense;
    });
    const allocations = bind.batch(async (page) => ({
      projects: await projects.load(page),
      spending: await spending.load(page),
    }));
    return [
      allocations.fields(
        expenseListItemOut.pick({
          projectId: true,
          projectName: true,
          productId: true,
          productName: true,
          purchaseId: true,
          vendorId: true,
          vendor: true,
          beneficiaries: true,
          funders: true,
          sourceClaims: true,
          spendingCategoryId: true,
          spendingCategoryName: true,
          projectAllocations: true,
          spendingCategoryAllocations: true,
        }),
        (row, loaded) => {
          if (!row.attributions || !row.sourceClaims)
            throw new Error("Expense audit children were not loaded");
          const attributions = row.attributions.map((value) => {
            if (!("ledgerParty" in value))
              throw new Error("Expense attribution relation was not loaded");
            return value;
          });
          return expenseRelationFields({
            ...expenseJoinedRow(row),
            attributions,
            sourceClaims: row.sourceClaims,
            projectAllocations: loaded.projects.get(row.id) ?? [],
            spendingCategoryAllocations: loaded.spending.get(row.id),
          });
        },
      ),
      spending.fields(
        expenseListItemOut.pick({
          trade: true,
          purchaseDate: true,
          purchaseDisplayLabel: true,
          orderId: true,
          orderUrl: true,
        }),
        (row, loaded) =>
          expenseDerivedFields({
            ...expenseJoinedRow(row),
            spendingCategoryAllocations: loaded.get(row.id),
          }),
      ),
      allocations.fields(
        expenseListItemOut.pick({ fieldResolutions: true }),
        (row, loaded) =>
          expenseResolutionFields({
            ...expenseJoinedRow(row),
            projectAllocations: loaded.projects.get(row.id) ?? [],
            spendingCategoryAllocations: loaded.spending.get(row.id),
          }),
      ),
      bind(expenseListItemOut.pick({ vendorLogo: true }), (row) =>
        expenseMediaFields(expenseJoinedRow(row)),
      ),
    ];
  },
});

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
