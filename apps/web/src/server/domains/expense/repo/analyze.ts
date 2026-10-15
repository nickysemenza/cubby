/**
 * Complete, bounded aggregates for the interactive Expense analyzer.
 *
 * This module deliberately groups in PostgreSQL only. The browser's ledger is
 * paginated/infinite and is therefore never an analytical population. Every
 * query starts from `buildExpenseWhereClause`, the exact filter compiler the
 * ledger uses.
 */
import type {
  ExpenseAnalyzeAggregate,
  ExpenseAnalyzeBucket,
  ExpenseAnalyzeColumnDimension,
  ExpenseAnalyzeInput,
  ExpenseAnalyzeOut,
  ExpenseAnalyzeRowDimension,
  ExpenseFacetCountsInput,
  ExpenseFacetCountsOut,
  ExpenseFilters,
} from "@cubby/schemas/project";
import { expenseFacetCountsOut } from "@cubby/schemas/project";
import { endOfMonth, format, parseISO } from "date-fns";
import {
  and,
  eq,
  isNotNull,
  notExists,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { plainDateDaysBetween, shiftPlainDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  project,
  purchase,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import {
  EXPENSE_MONTH_BUCKET,
  expenseShareAggregateFields,
} from "~/server/domains/expense/repo/expense-aggregate-sql";
import {
  executeExpenseDerivedBatch,
  executeExpenseDerivedBatches,
  type DerivedProjectionQuery,
  type ExpenseDerivedReadContext,
  type ExpenseDerivedBatchRead,
  expenseDerivedCostRead,
  expenseDerivedReadSql,
  expenseSelectionForWhere,
} from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveExpenseProjectSql } from "~/server/domains/expense/repo/expense-inheritance";
import {
  expenseAllocationScopeConditionSql,
  type ExpenseAllocationProjectScope,
} from "~/server/domains/expense/repo/expense-project-allocation";

import {
  buildExpenseWhereClause,
  resolveExpenseProjectAllocationScope,
} from "./lookup";

const ROW_LIMIT = 200;
const MONTH_COLUMN_LIMIT = 24;
const CELL_LIMIT = 1_000;

type Dimension = ExpenseAnalyzeRowDimension | ExpenseAnalyzeColumnDimension;
type AggregateRow = {
  actual: number;
  committed: number;
  credits: number;
  net: number;
  count: number;
};
type BucketRow = AggregateRow & { key: string; label: string };
type CellRow = AggregateRow & { rowKey: string; columnKey: string | null };
type FacetId = ExpenseFacetCountsInput["facetIds"][number];

/**
 * The analyzer's closed set of axes. Project and vendor deliberately carry
 * their live-join requirement here: a dangling or soft-deleted relation is an
 * unattributed expense, not a bucket with a stale label.
 */
const dimensionSpecs = {
  // Trade and cost type are per-share: an adjustment follows its principals.
  trade: {
    key: sql<string>`allocation.trade`,
    label: sql<string>`allocation.trade`,
    relation: "allocation",
  },
  costType: {
    key: sql<string>`allocation."costType"`,
    label: sql<string>`allocation."costType"`,
    relation: "allocation",
  },
  month: {
    key: EXPENSE_MONTH_BUCKET,
    label: EXPENSE_MONTH_BUCKET,
    relation: "expense",
  },
  spendingCategory: {
    key: spendingCategory.shortcode,
    label: spendingCategory.name,
    relation: "spendingCategory",
  },
  project: { key: project.shortcode, label: project.name, relation: "project" },
  vendor: { key: vendor.shortcode, label: vendor.name, relation: "vendor" },
} as const satisfies Record<
  Dimension,
  {
    key: SQLWrapper;
    label: SQLWrapper;
    relation:
      | "expense"
      | "project"
      | "vendor"
      | "spendingCategory"
      | "allocation";
  }
>;

type DirectDimension = Exclude<Dimension, "project" | "vendor">;

/** Scalar facets all share the same cardinality query and null label policy. */
const scalarFacetSpecs = {
  lineKind: { value: expense.lineKind },
  lineBasis: { value: expense.lineBasis },
  future: {
    value: sql<string>`case when ${expense.future} then 'true' else 'false' end`,
  },
  productPresence: {
    value: sql<string>`case when ${expense.productId} is null then 'none' else 'has' end`,
  },
} as const satisfies Record<
  Exclude<FacetId, AllocatedFacetId | "project" | "vendor" | "orderIdPresence">,
  { value: SQLWrapper }
>;

type ScalarFacetId = keyof typeof scalarFacetSpecs;
type AllocatedFacetId = "trade" | "costType";

const isExpenseAllocatedFacet = (id: FacetId): id is AllocatedFacetId =>
  id === "trade" || id === "costType";

function isExpenseScalarFacet(
  id: FacetId,
): id is ScalarFacetId | AllocatedFacetId {
  return Object.hasOwn(scalarFacetSpecs, id) || isExpenseAllocatedFacet(id);
}

const zeroAggregate = (): ExpenseAnalyzeAggregate => ({
  actual: 0,
  committed: 0,
  credits: 0,
  net: 0,
  count: 0,
});

const aggregate = (row: AggregateRow | undefined): ExpenseAnalyzeAggregate =>
  row
    ? {
        actual: Number(row.actual),
        committed: Number(row.committed),
        credits: Number(row.credits),
        net: Number(row.net),
        count: Number(row.count),
      }
    : zeroAggregate();

const addAggregate = (
  left: ExpenseAnalyzeAggregate,
  right: ExpenseAnalyzeAggregate,
): ExpenseAnalyzeAggregate => ({
  actual: left.actual + right.actual,
  committed: left.committed + right.committed,
  credits: left.credits + right.credits,
  net: left.net + right.net,
  count: left.count + right.count,
});

const subtractAggregate = (
  left: ExpenseAnalyzeAggregate,
  right: ExpenseAnalyzeAggregate,
): ExpenseAnalyzeAggregate => ({
  actual: left.actual - right.actual,
  committed: left.committed - right.committed,
  credits: left.credits - right.credits,
  net: left.net - right.net,
  count: left.count - right.count,
});

const bucketFilter = (
  dimension: Dimension,
  key: string,
): ExpenseAnalyzeBucket["filter"] => {
  const filter: ExpenseAnalyzeBucket["filter"] = {};
  switch (dimension) {
    case "trade":
      filter.trade = key;
      break;
    case "costType":
      filter.costType = key;
      break;
    case "spendingCategory":
      filter.spendingCategory = key;
      break;
    case "project":
      filter.project = key;
      break;
    case "vendor":
      filter.vendor = key;
      break;
    case "month":
      filter.dateFrom = `${key}-01`;
      filter.dateTo = format(endOfMonth(parseISO(`${key}-01`)), "yyyy-MM-dd");
      break;
  }
  return filter;
};

const dimensionColumns = (dimension: DirectDimension) =>
  dimensionSpecs[dimension];

const isAllocatedDimension = (dimension: Dimension) =>
  dimension === "project" ||
  dimension === "spendingCategory" ||
  dimension === "trade" ||
  dimension === "costType";

function scopeAggregateQuery(
  db: Database,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read.select(read.aggregate).where(where);
}

function allocatedAggregateQuery(
  db: Database,
  where: SQL | undefined,
  shareCondition: SQL,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  return getDb(db)
    .select(expenseShareAggregateFields())
    .from(expense)
    .innerJoin(
      prepared?.allocations ??
        sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
      sql`allocation."expenseId" = ${expense.id}`,
    )
    .where(
      and(
        where,
        shareCondition,
        allocationScope
          ? expenseAllocationScopeConditionSql("allocation", allocationScope)
          : undefined,
      ),
    );
}

function groupedDimensionQuery(
  db: Database,
  where: SQL | undefined,
  dimension: Dimension,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const database = getDb(db);
  const spec = dimensionSpecs[dimension];
  if (isAllocatedDimension(dimension)) {
    return database
      .select({
        key: spec.key,
        label: spec.label,
        ...expenseShareAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        prepared?.allocations ??
          sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
        sql`allocation."expenseId" = ${expense.id}`,
      )
      .leftJoin(
        project,
        and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
      )
      .leftJoin(
        spendingCategory,
        and(
          sql`${spendingCategory.id} = allocation."spendingCategoryId"`,
          notDeleted(spendingCategory),
        ),
      )
      .where(
        and(
          where,
          isNotNull(spec.key),
          allocationScope
            ? expenseAllocationScopeConditionSql("allocation", allocationScope)
            : undefined,
        ),
      )
      .groupBy(spec.key, spec.label)
      .orderBy(spec.label);
  }
  const charge = alias(purchase, "analyzeDimensionCharge");
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read
    .select({
      key: spec.key,
      label: spec.label,
      ...read.aggregate,
    })
    .leftJoin(
      project,
      and(eq(effectiveExpenseProjectSql(), project.id), notDeleted(project)),
    )
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      spec.relation === "expense" ? where : and(where, isNotNull(spec.key)),
    )
    .groupBy(spec.key, spec.label)
    .orderBy(spec.label);
}

function groupedCellsQuery(
  db: Database,
  where: SQL | undefined,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const database = getDb(db);
  const row = dimensionSpecs[rowDimension];
  const column = dimensionColumns(columnDimension);
  if (
    isAllocatedDimension(rowDimension) ||
    isAllocatedDimension(columnDimension)
  ) {
    const charge = alias(purchase, "analyzeAllocatedCellCharge");
    return database
      .select({
        rowKey: row.key,
        columnKey: column.key,
        ...expenseShareAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        prepared?.allocations ??
          sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
        sql`allocation."expenseId" = ${expense.id}`,
      )
      .leftJoin(
        project,
        and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
      )
      .leftJoin(
        spendingCategory,
        and(
          sql`${spendingCategory.id} = allocation."spendingCategoryId"`,
          notDeleted(spendingCategory),
        ),
      )
      .leftJoin(
        charge,
        and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
      )
      .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
      .where(
        and(
          where,
          row.relation !== "expense" ? isNotNull(row.key) : undefined,
          column.relation !== "expense" ? isNotNull(column.key) : undefined,
          allocationScope
            ? expenseAllocationScopeConditionSql("allocation", allocationScope)
            : undefined,
        ),
      )
      .groupBy(row.key, column.key)
      .orderBy(row.key, column.key);
  }
  const charge = alias(purchase, "analyzeCellCharge");
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read
    .select({
      rowKey: row.key,
      columnKey: column.key,
      ...read.aggregate,
    })
    .leftJoin(
      project,
      and(eq(effectiveExpenseProjectSql(), project.id), notDeleted(project)),
    )
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
    .where(row.relation === "expense" ? where : and(where, isNotNull(row.key)))
    .groupBy(row.key, column.key)
    .orderBy(row.key, column.key);
}

/**
 * Distinct Expenses in an allocated grid. One adjustment split across several
 * buckets counts once in each, so summing cell counts would overstate the grid.
 */
function allocatedGridCountQuery(
  db: Database,
  where: SQL | undefined,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension | null | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const keys = [rowDimension, columnDimension]
    .filter((dimension) => dimension != null)
    .map((dimension) => dimensionSpecs[dimension])
    .filter((spec) => spec.relation !== "expense")
    .map((spec) => isNotNull(spec.key));
  const charge = alias(purchase, "analyzeGridCountCharge");
  return getDb(db)
    .select({ count: sql<number>`count(distinct ${expense.id})::int` })
    .from(expense)
    .innerJoin(
      prepared?.allocations ??
        sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
      sql`allocation."expenseId" = ${expense.id}`,
    )
    .leftJoin(
      project,
      and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
    )
    .leftJoin(
      spendingCategory,
      and(
        sql`${spendingCategory.id} = allocation."spendingCategoryId"`,
        notDeleted(spendingCategory),
      ),
    )
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      and(
        where,
        ...keys,
        allocationScope
          ? expenseAllocationScopeConditionSql("allocation", allocationScope)
          : undefined,
      ),
    );
}

export function previousExpenseFilters(filters: ExpenseFilters) {
  // The schema rejects unbounded comparison requests. This guard keeps the
  // repository sound for direct internal callers as well.
  if (!filters.dateFrom || !filters.dateTo) {
    throw new Error("Previous-period comparison requires dateFrom and dateTo");
  }
  const days = plainDateDaysBetween(filters.dateFrom, filters.dateTo) + 1;
  const dateTo = shiftPlainDate(filters.dateFrom, -1);
  const dateFrom = shiftPlainDate(filters.dateFrom, -days);
  // An explicit comparison window replaces every date-window constraint. A
  // saved relative predicate (for example, `beforeToday`) must not continue to
  // narrow the shifted period behind the user's back.
  const { dateRelative: _dateRelative, ...nonRelativeFilters } = filters;
  return {
    filters: { ...nonRelativeFilters, dateFrom, dateTo },
    range: { dateFrom, dateTo },
  };
}

function emptyExpenseFacetFilters(
  filters: ExpenseFilters,
  facet: ExpenseFacetCountsInput["facetIds"][number],
): ExpenseFilters {
  const copy = { ...filters };
  switch (facet) {
    case "costType":
      delete copy.costType;
      break;
    case "lineKind":
      delete copy.lineKind;
      break;
    case "lineBasis":
      delete copy.lineBasis;
      break;
    case "trade":
      delete copy.trade;
      break;
    case "future":
      delete copy.future;
      break;
    case "project":
      delete copy.projectId;
      delete copy.projectPresenceFilter;
      delete copy.includeSubProjects;
      break;
    case "productPresence":
      delete copy.productPresenceFilter;
      break;
    case "vendor":
      delete copy.vendorId;
      delete copy.vendorPresenceFilter;
      break;
    case "orderIdPresence":
      delete copy.orderIdPresenceFilter;
      break;
  }
  return copy;
}

/**
 * SQL can only return populated groups. Preserve a currently-selected option
 * with a zero so a filtered-away chip remains intelligible and removable.
 */
function selectedExpenseFacetValues(
  filters: ExpenseFilters,
  facet: ExpenseFacetCountsInput["facetIds"][number],
): string[] {
  const asStrings = (value: string | string[] | undefined) =>
    value === undefined ? [] : [value].flat();
  const nullableSentinel = (value: "has" | "none" | undefined) =>
    value === "has" ? "__any__" : value === "none" ? "__none__" : undefined;
  switch (facet) {
    case "costType":
      return asStrings(filters.costType);
    case "lineKind":
      return asStrings(filters.lineKind);
    case "lineBasis":
      return asStrings(filters.lineBasis);
    case "trade":
      return asStrings(filters.trade);
    case "future":
      return filters.future === undefined ? [] : [String(filters.future)];
    case "project":
      return [
        ...asStrings(filters.projectId),
        nullableSentinel(filters.projectPresenceFilter),
      ].filter((value): value is string => value !== undefined);
    case "productPresence":
      return filters.productPresenceFilter
        ? [filters.productPresenceFilter]
        : [];
    case "vendor":
      return [
        ...asStrings(filters.vendorId),
        nullableSentinel(filters.vendorPresenceFilter),
      ].filter((value): value is string => value !== undefined);
    case "orderIdPresence":
      return filters.orderIdPresenceFilter
        ? [filters.orderIdPresenceFilter]
        : [];
  }
}

function includeSelectedExpenseFacetZeroOptions(
  options: ExpenseFacetCountsOut["facets"][number]["options"],
  selected: string[],
) {
  const present = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...selected
      .filter((value) => !present.has(value))
      .map((value) => ({ value, label: null, count: 0 })),
  ];
}

function scalarFacetQuery(
  db: Database,
  where: SQL | undefined,
  spec: (typeof scalarFacetSpecs)[keyof typeof scalarFacetSpecs],
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read
    .select({
      value: spec.value,
      label: sql<string | null>`NULL::text`,
      count: sql<number>`count(*)::int`,
    })
    .where(where)
    .groupBy(spec.value);
}

/** A row counts once per distinct trade or cost type among its shares. */
function allocatedFacetQuery(
  db: Database,
  where: SQL | undefined,
  id: AllocatedFacetId,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const value = dimensionSpecs[id].key;
  return getDb(db)
    .select({
      value,
      label: sql<string | null>`NULL::text`,
      count: sql<number>`count(distinct ${expense.id})::int`,
    })
    .from(expense)
    .innerJoin(
      prepared?.allocations ??
        sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
      sql`allocation."expenseId" = ${expense.id}`,
    )
    .where(
      and(
        where,
        isNotNull(value),
        allocationScope
          ? expenseAllocationScopeConditionSql("allocation", allocationScope)
          : undefined,
      ),
    )
    .groupBy(value);
}

/**
 * Facet entity buckets intentionally use the same live relation definition as
 * analyzer axes. Presence below remains raw-FK based, so it can distinguish a
 * linked row from no link without changing the existing filter semantics.
 */
function entityFacetQuery(
  db: Database,
  where: SQL | undefined,
  dimension: "project" | "vendor",
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  if (dimension === "project") {
    return getDb(db)
      .select({
        value: project.shortcode,
        label: project.name,
        count: sql<number>`count(distinct ${expense.id})::int`,
      })
      .from(expense)
      .innerJoin(
        prepared?.allocations ??
          sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
        sql`allocation."expenseId" = ${expense.id}`,
      )
      .innerJoin(
        project,
        and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
      )
      .where(
        and(
          where,
          allocationScope
            ? expenseAllocationScopeConditionSql("allocation", allocationScope)
            : undefined,
        ),
      )
      .groupBy(project.shortcode, project.name)
      .orderBy(project.name);
  }

  const spec = dimensionSpecs[dimension];
  const charge = alias(purchase, "facetDimensionCharge");
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read
    .select({
      value: spec.key,
      label: spec.label,
      count: sql<number>`count(*)::int`,
    })
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
    .where(and(where, isNotNull(spec.key)))
    .groupBy(spec.key, spec.label)
    .orderBy(spec.label);
}

function presenceFacetQuery(
  db: Database,
  where: SQL | undefined,
  column: typeof expense.purchaseId,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  return read
    .select({
      any: sql<number>`count(*) filter (where ${column} is not null)::int`,
      none: sql<number>`count(*) filter (where ${column} is null)::int`,
    })
    .where(where);
}

function projectPresenceFacetQuery(
  db: Database,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  return getDb(db)
    .select({
      any: sql<number>`count(distinct ${expense.id}) filter (where allocation."projectId" IS NOT NULL)::int`,
      none: sql<number>`count(distinct ${expense.id}) filter (where allocation."projectId" IS NULL)::int`,
    })
    .from(expense)
    .innerJoin(
      prepared?.allocations ??
        sql`(${expenseDerivedReadSql("shares", { scope: allocationScope })}) allocation`,
      sql`allocation."expenseId" = ${expense.id}`,
    )
    .where(where);
}

export type ExpenseAnalysisPeriod = {
  rows: BucketRow[];
  columns: BucketRow[];
  cells: CellRow[];
  scope: ExpenseAnalyzeAggregate;
  causes: ExpenseAnalysisCauses;
  /** Distinct Expenses in an allocated grid; absent when cells partition rows. */
  gridCount?: number;
};

const asOneDimensionCells = (rows: BucketRow[]): CellRow[] =>
  rows.map(({ key, ...row }) => ({
    ...row,
    rowKey: key,
    columnKey: null,
  }));

export const loadExpenseAnalysisPeriod = async (
  db: Database,
  gridWhere: SQL | undefined,
  scopeWhere: SQL | undefined,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension | null | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
): Promise<ExpenseAnalysisPeriod> => {
  const allocated =
    isAllocatedDimension(rowDimension) ||
    (columnDimension != null && isAllocatedDimension(columnDimension));
  const projections = await executeExpenseDerivedBatch(
    db,
    {
      scope: allocationScope,
      where: scopeWhere,
      expenseIds: expenseSelectionForWhere(or(gridWhere, scopeWhere)),
    },
    (read) => ({
      rows: groupedDimensionQuery(
        db,
        gridWhere,
        rowDimension,
        allocationScope,
        read,
      ),
      columns: groupedDimensionQuery(
        db,
        columnDimension ? gridWhere : sql`false`,
        columnDimension ?? "month",
        allocationScope,
        read,
      ),
      cells: groupedCellsQuery(
        db,
        columnDimension ? gridWhere : sql`false`,
        rowDimension,
        columnDimension ?? "month",
        allocationScope,
        read,
      ),
      scope: scopeAggregateQuery(db, scopeWhere, allocationScope, read),
      gridCount: allocatedGridCountQuery(
        db,
        allocated ? gridWhere : sql`false`,
        rowDimension,
        columnDimension,
        allocationScope,
        read,
      ),
      ...analysisCausesQueries(
        db,
        { rowDimension, columnDimension },
        scopeWhere,
        allocationScope,
        read,
      ),
    }),
  );
  const rows = projections.rows.map((row) => ({
    ...row,
    key: String(row.key),
    label: String(row.label),
  }));
  const columns = columnDimension
    ? projections.columns.map((row) => ({
        ...row,
        key: String(row.key),
        label: String(row.label),
      }))
    : [];
  const cells = columnDimension
    ? projections.cells.map((row) => ({ ...row, rowKey: String(row.rowKey) }))
    : asOneDimensionCells(rows);
  return {
    rows,
    columns,
    cells,
    scope: aggregate(projections.scope[0]),
    gridCount: allocated
      ? Number(projections.gridCount[0]?.count ?? 0)
      : undefined,
    causes: analysisCausesFromRows(projections),
  };
};

const analysisLimitResult = (
  rowCount: number,
  columnCount: number,
  cellCount: number,
  columnDimension: ExpenseAnalyzeColumnDimension | null | undefined,
): ExpenseAnalyzeOut | null => {
  if (rowCount > ROW_LIMIT) {
    return {
      status: "too_large",
      reason: "row_limit",
      limit: ROW_LIMIT,
      observedAtLeast: rowCount,
    };
  }
  if (columnDimension === "month" && columnCount > MONTH_COLUMN_LIMIT) {
    return {
      status: "too_large",
      reason: "month_column_limit",
      limit: MONTH_COLUMN_LIMIT,
      observedAtLeast: columnCount,
    };
  }
  if (cellCount > CELL_LIMIT) {
    return {
      status: "too_large",
      reason: "cell_limit",
      limit: CELL_LIMIT,
      observedAtLeast: cellCount,
    };
  }
  return null;
};

const mergeAnalysisCells = (
  currentRows: CellRow[],
  previousRows: CellRow[],
  hasComparison: boolean,
) => {
  const keyFor = (cell: CellRow) =>
    `${cell.rowKey}\u0000${cell.columnKey ?? ""}`;
  const current = new Map(currentRows.map((cell) => [keyFor(cell), cell]));
  const previous = new Map(previousRows.map((cell) => [keyFor(cell), cell]));
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const cells = [...keys].map((key) => {
    const currentCell = current.get(key);
    const previousCell = previous.get(key);
    const exemplar = currentCell ?? previousCell;
    if (!exemplar) {
      throw new Error(`Expense analysis cell ${key} has no source row`);
    }
    return {
      rowKey: exemplar.rowKey,
      columnKey: exemplar.columnKey,
      current: aggregate(currentCell),
      previous: hasComparison ? aggregate(previousCell) : null,
    };
  });
  return { cells, count: keys.size };
};

const analysisCausesQueries = (
  db: Database,
  input: Pick<ExpenseAnalyzeInput, "rowDimension" | "columnDimension">,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) => {
  const liveCharge = alias(purchase, "analyzeLiveCharge");
  const missingVendor = notExists(
    getDb(db)
      .select({ id: liveCharge.id })
      .from(liveCharge)
      .innerJoin(
        vendor,
        and(eq(liveCharge.vendorId, vendor.id), notDeleted(vendor)),
      )
      .where(
        and(eq(liveCharge.id, expense.purchaseId), notDeleted(liveCharge)),
      ),
  );
  return {
    unallocated: allocatedAggregateQuery(
      db,
      input.rowDimension === "trade" || input.columnDimension === "trade"
        ? where
        : sql`false`,
      sql`allocation.trade IS NULL`,
      allocationScope,
      prepared,
    ),
    unattributedProject: allocatedAggregateQuery(
      db,
      input.rowDimension === "project" ? where : sql`false`,
      sql`allocation."projectId" IS NULL`,
      allocationScope,
      prepared,
    ),
    unattributedVendor: scopeAggregateQuery(
      db,
      input.rowDimension === "vendor" ? and(where, missingVendor) : sql`false`,
      allocationScope,
      prepared,
    ),
  };
};

const analysisCausesFromRows = (rows: {
  [K in keyof ReturnType<typeof analysisCausesQueries>]: ReturnType<
    typeof analysisCausesQueries
  >[K]["_"]["result"];
}) => ({
  unallocated: aggregate(rows.unallocated[0]),
  unattributedProject: aggregate(rows.unattributedProject[0]),
  unattributedVendor: aggregate(rows.unattributedVendor[0]),
});

export const loadExpenseAnalysisCauses = async (
  db: Database,
  input: ExpenseAnalyzeInput,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseAnalysisCauses,
): Promise<ExpenseAnalysisCauses> =>
  prepared ??
  analysisCausesFromRows(
    await executeExpenseDerivedBatch(
      db,
      {
        scope: allocationScope,
        where,
        expenseIds: expenseSelectionForWhere(where),
      },
      (read) => analysisCausesQueries(db, input, where, allocationScope, read),
    ),
  );

const projectAnalysisBuckets = (
  rows: Map<string, BucketRow>,
  dimension: Dimension,
) =>
  [...rows.values()].map((row) => ({
    key: row.key,
    label: row.label,
    filter: bucketFilter(dimension, row.key),
  }));

export type ExpenseAnalysisCauses = ReturnType<typeof analysisCausesFromRows>;
export type ExpenseAnalysisComparison = ReturnType<
  typeof previousExpenseFilters
> | null;

export const buildExpenseAnalysisGrid = (
  current: ExpenseAnalysisPeriod,
  previous: ExpenseAnalysisPeriod | null,
  comparison: ExpenseAnalysisComparison,
  columnDimension: ExpenseAnalyzeColumnDimension | null | undefined,
) => {
  const rowMap = new Map(
    [...current.rows, ...(previous?.rows ?? [])].map((row) => [row.key, row]),
  );
  const columnMap = new Map(
    [...current.columns, ...(previous?.columns ?? [])].map((row) => [
      row.key,
      row,
    ]),
  );
  const mergedCells = mergeAnalysisCells(
    current.cells,
    previous?.cells ?? [],
    comparison !== null,
  );
  const cells = mergedCells.cells;
  const withGridCount = (
    total: ExpenseAnalyzeAggregate,
    period: ExpenseAnalysisPeriod | null,
  ) =>
    period?.gridCount === undefined
      ? total
      : { ...total, count: period.gridCount };
  const gridCurrent = withGridCount(
    cells.reduce(
      (total, cell) => addAggregate(total, cell.current),
      zeroAggregate(),
    ),
    current,
  );
  const gridPrevious = comparison
    ? withGridCount(
        cells.reduce(
          (total, cell) =>
            addAggregate(total, cell.previous ?? zeroAggregate()),
          zeroAggregate(),
        ),
        previous,
      )
    : null;
  return {
    rowMap,
    columnMap,
    cells,
    gridCurrent,
    gridPrevious,
    limitResult: analysisLimitResult(
      rowMap.size,
      columnMap.size,
      mergedCells.count,
      columnDimension,
    ),
  };
};

const analysisPair = (
  current: ExpenseAnalyzeAggregate,
  previous: ExpenseAnalyzeAggregate | null,
) => ({ current, previous });

const buildAnalysisReconciliation = (
  current: ExpenseAnalysisPeriod,
  previous: ExpenseAnalysisPeriod | null,
  grid: ReturnType<typeof buildExpenseAnalysisGrid>,
  currentCauses: ExpenseAnalysisCauses,
  previousCauses: ExpenseAnalysisCauses | null,
) => ({
  tail: analysisPair(
    subtractAggregate(current.scope, grid.gridCurrent),
    previous?.scope && grid.gridPrevious
      ? subtractAggregate(previous.scope, grid.gridPrevious)
      : null,
  ),
  causes: {
    unallocated: analysisPair(
      currentCauses.unallocated,
      previousCauses?.unallocated ?? null,
    ),
    unattributedProject: analysisPair(
      currentCauses.unattributedProject,
      previousCauses?.unattributedProject ?? null,
    ),
    unattributedVendor: analysisPair(
      currentCauses.unattributedVendor,
      previousCauses?.unattributedVendor ?? null,
    ),
  },
});

export const readyExpenseAnalysisOutput = (
  input: ExpenseAnalyzeInput,
  comparison: ExpenseAnalysisComparison,
  current: ExpenseAnalysisPeriod,
  previous: ExpenseAnalysisPeriod | null,
  grid: ReturnType<typeof buildExpenseAnalysisGrid>,
  currentCauses: ExpenseAnalysisCauses,
  previousCauses: ExpenseAnalysisCauses | null,
): ExpenseAnalyzeOut => {
  return {
    status: "ready",
    rowDimension: input.rowDimension,
    columnDimension: input.columnDimension ?? null,
    comparison: {
      mode: input.comparison,
      previousRange: comparison?.range ?? null,
    },
    rows: projectAnalysisBuckets(grid.rowMap, input.rowDimension),
    columns: input.columnDimension
      ? projectAnalysisBuckets(grid.columnMap, input.columnDimension)
      : [],
    cells: grid.cells,
    totals: {
      scope: analysisPair(current.scope, previous?.scope ?? null),
      grid: analysisPair(grid.gridCurrent, grid.gridPrevious),
    },
    reconciliation: buildAnalysisReconciliation(
      current,
      previous,
      grid,
      currentCauses,
      previousCauses,
    ),
  };
};

function orderIdFacetQuery(
  db: Database,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
  prepared?: ExpenseDerivedBatchRead,
) {
  const charge = alias(purchase, "facetOrderCharge");
  const read = prepared ?? expenseDerivedCostRead(db, allocationScope);
  const value = sql<string>`case when ${charge.orderId} is null then 'none' else 'has' end`;
  return read
    .select({
      value,
      label: sql<string | null>`NULL::text`,
      count: sql<number>`count(*)::int`,
    })
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .where(where)
    .groupBy(value);
}

const facetPresenceRows = z.array(
  z.object({ any: z.number(), none: z.number() }),
);
const facetOptionRows =
  expenseFacetCountsOut.shape.facets.element.shape.options;

export async function loadExpenseFacetCounts(
  db: Database,
  input: ExpenseFacetCountsInput,
): Promise<ExpenseFacetCountsOut> {
  const contexts: Record<string, ExpenseDerivedReadContext> = {};
  const preparedByFilters = new Map<
    string,
    Promise<ExpenseDerivedReadContext>
  >();
  for (const id of input.facetIds) {
    const filters = emptyExpenseFacetFilters(input.filters, id);
    const key = JSON.stringify(filters);
    let prepared = preparedByFilters.get(key);
    if (!prepared) {
      prepared = (async () => {
        const scope = await resolveExpenseProjectAllocationScope(db, filters);
        const where = await buildExpenseWhereClause(db, filters, {
          projectScope: undefined,
        });
        return {
          scope,
          where,
          expenseIds: expenseSelectionForWhere(where),
        };
      })();
      preparedByFilters.set(key, prepared);
    }
    contexts[id] = await prepared;
  }
  if (input.facetIds.length === 0) return { facets: [] };
  const projected = await executeExpenseDerivedBatches(
    db,
    contexts,
    (reads) => {
      const queries: Record<string, DerivedProjectionQuery> = {};
      for (const id of input.facetIds) {
        const read = reads[id]!;
        const { where, scope } = read;
        const key = `rows_${id}`;
        if (isExpenseAllocatedFacet(id))
          queries[key] = allocatedFacetQuery(db, where, id, scope, read);
        else if (isExpenseScalarFacet(id))
          queries[key] = scalarFacetQuery(
            db,
            where,
            scalarFacetSpecs[id],
            scope,
            read,
          );
        else if (id === "project" || id === "vendor") {
          queries[key] = entityFacetQuery(db, where, id, scope, read);
          queries[`presence_${id}`] =
            id === "project"
              ? projectPresenceFacetQuery(db, where, scope, read)
              : presenceFacetQuery(db, where, expense.purchaseId, scope, read);
        } else queries[key] = orderIdFacetQuery(db, where, scope, read);
      }
      return queries;
    },
  );
  return {
    facets: input.facetIds.map((id) => {
      let options = facetOptionRows.parse(projected[`rows_${id}`]);
      if (id === "project" || id === "vendor") {
        const [presence] = facetPresenceRows.parse(projected[`presence_${id}`]);
        options = [
          { value: "__any__", label: null, count: presence?.any ?? 0 },
          { value: "__none__", label: null, count: presence?.none ?? 0 },
          ...options,
        ];
      }
      return {
        id,
        options: includeSelectedExpenseFacetZeroOptions(
          options,
          selectedExpenseFacetValues(input.filters, id),
        ),
      };
    }),
  };
}
