import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { type ExpenseId, parseEntityId } from "@cubby/schemas/identifiers";
import { expenseCostSign } from "@cubby/schemas/project";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { rawExpenseListItemOut } from "@cubby/schemas/work-raw-read";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, notDeleted, relations, unwrapDb } from "~/server/db/helpers";
import { quotedTable, related } from "~/server/db/helpers/related";
import {
  expense,
  project,
  purchase,
  spendingCategory,
} from "~/server/db/schema";
import {
  expenseDerivedValueSql,
  expenseSelectionForWhere,
} from "~/server/domains/expense/repo/expense-derived-read";
import { expenseSearch } from "~/server/domains/expense/repo/search-read-expense";
import { disposalPurchaseIds } from "~/server/domains/product/repo/ownership";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import {
  vendorLogoKeySql,
  vendorLogoSummary,
} from "~/server/domains/vendor/repo/vendor-logo";
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
  projectId: related(
    project,
    (p) => sql`${p.id} = ${effectiveExpenseProjectSql(quotedTable(expense))}`,
  ).value<string>((p) => p.name),
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
const qb = new QueryBuilder();

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
  read: {
    search: expenseSearch,
    media: true,
    columns: {
      vendorLogoKey: vendorLogoKeySql(
        sql`(${qb
          .select({ vendorId: purchase.vendorId })
          .from(purchase)
          .where(
            and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
          )})`,
      ),
    },
    bindings: (bind) => {
      const joined = bind.ids(({ db, ids }) =>
        loadExpenseJoinedRows(
          db,
          ids.map((id) => parseEntityId("expense", id)),
        ),
      );
      const spending = bind.ids(({ db, ids }) =>
        loadExpenseSpendingAllocations(
          db,
          ids.map((id) => parseEntityId("expense", id)),
        ),
      );
      const projects = bind.ids(async ({ db, ids }) => {
        const values = await loadExpenseProjectAllocations(
          db,
          ids.map((id) => parseEntityId("expense", id)),
        );
        const byExpense = new Map<ExpenseId, typeof values>();
        for (const value of values) {
          const group = byExpense.get(value.expenseId) ?? [];
          group.push(value);
          byExpense.set(value.expenseId, group);
        }
        return byExpense;
      });
      const allocations = bind.ids(async (page) => {
        const [rows, projectValues, spendingValues] = await Promise.all([
          joined.load(page),
          projects.load(page),
          spending.load(page),
        ]);
        return { rows, projects: projectValues, spending: spendingValues };
      });
      const rowOf = (
        rows: ReadonlyMap<ExpenseId, ExpenseJoinedRow>,
        id: ExpenseId,
      ) => {
        const row = rows.get(id);
        if (!row) throw new Error(`Expense relations were not loaded: ${id}`);
        return row;
      };
      return [
        allocations.fields(
          rawExpenseListItemOut.pick({
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
            const value = rowOf(loaded.rows, row.id);
            const attributions = value.attributions.map((attribution) => {
              if (!("ledgerParty" in attribution))
                throw new Error("Expense attribution relation was not loaded");
              return attribution;
            });
            return expenseRelationFields({
              ...value,
              attributions,
              projectAllocations: loaded.projects.get(row.id) ?? [],
              spendingCategoryAllocations: loaded.spending.get(row.id),
            });
          },
        ),
        bind
          .ids(async (page) => ({
            rows: await joined.load(page),
            spending: await spending.load(page),
          }))
          .fields(
            rawExpenseListItemOut.pick({
              trade: true,
              purchaseDate: true,
              purchaseDisplayLabel: true,
              orderId: true,
              orderUrl: true,
            }),
            (row, loaded) =>
              expenseDerivedFields({
                ...rowOf(loaded.rows, row.id),
                spendingCategoryAllocations: loaded.spending.get(row.id),
              }),
          ),
        allocations.fields(
          rawExpenseListItemOut.pick({ fieldResolutions: true }),
          (row, loaded) =>
            expenseResolutionFields({
              ...rowOf(loaded.rows, row.id),
              projectAllocations: loaded.projects.get(row.id) ?? [],
              spendingCategoryAllocations: loaded.spending.get(row.id),
            }),
        ),
        bind(rawExpenseListItemOut.pick({ vendorLogo: true }), (row) => ({
          vendorLogo: vendorLogoSummary(row),
        })),
      ];
    },
  },
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
export const analyticsFilters = (filters: ExpenseFilters): ExpenseFilters => {
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

// The relation-loaded rows the expense field helpers read, by id.
const loadExpenseJoinedRows = async (
  db: Database | DrizzleTransaction,
  ids: readonly ExpenseId[],
) => {
  const declared = relations.expense.withProject.with;
  const rows =
    ids.length === 0
      ? []
      : await unwrapDb(db).query.expense.findMany({
          where: inArray(expense.id, [...ids]),
          extras: expenseInheritanceReadExtras(),
          with: {
            project: declared.project,
            product: declared.product,
            purchase: declared.purchase,
            attributions: declared.attributions,
            sourceClaims: declared.sourceClaims,
          },
        });
  return new Map(
    rows.map((row) => {
      if (row.purchase && !("vendor" in row.purchase))
        throw new Error("Expense vendor relation was not loaded");
      return [
        row.id,
        {
          ...row,
          project: row.project ?? null,
          product: row.product ?? null,
          purchase: row.purchase ?? null,
        },
      ] as const;
    }),
  );
};
type ExpenseJoinedRow =
  Awaited<ReturnType<typeof loadExpenseJoinedRows>> extends Map<
    unknown,
    infer Row
  >
    ? Row
    : never;
