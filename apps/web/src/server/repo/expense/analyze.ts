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
import {
  differenceInCalendarDays,
  endOfMonth,
  format,
  parseISO,
  subDays,
} from "date-fns";
import {
  and,
  eq,
  isNotNull,
  ne,
  notExists,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { expense, project, purchase, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  EXPENSE_MONTH_BUCKET,
  expenseAggregateFields,
} from "~/server/repo/expense-aggregate-sql";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "~/server/repo/expense-inheritance";
import {
  expenseAllocatedCostSql,
  expenseAllocationScopeConditionSql,
  expenseProjectAllocationSql,
  type ExpenseAllocationProjectScope,
} from "~/server/repo/expense-project-allocation";

import { buildExpenseWhereClause } from "./lookup";

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
export type ExpenseFacetId = ExpenseFacetCountsInput["facetIds"][number];
type FacetId = ExpenseFacetId;

/**
 * The analyzer's closed set of axes. Project and vendor deliberately carry
 * their live-join requirement here: a dangling or soft-deleted relation is an
 * unattributed expense, not a bucket with a stale label.
 */
const dimensionSpecs = {
  trade: {
    key: effectiveExpenseTradeSql(),
    label: effectiveExpenseTradeSql(),
    relation: "expense",
  },
  costType: {
    key: expense.costType,
    label: expense.costType,
    relation: "expense",
  },
  month: {
    key: EXPENSE_MONTH_BUCKET,
    label: EXPENSE_MONTH_BUCKET,
    relation: "expense",
  },
  project: { key: project.shortcode, label: project.name, relation: "project" },
  vendor: { key: vendor.shortcode, label: vendor.name, relation: "vendor" },
} as const satisfies Record<
  Dimension,
  {
    key: SQLWrapper;
    label: SQLWrapper;
    relation: "expense" | "project" | "vendor";
  }
>;

type DirectDimension = Exclude<Dimension, "project" | "vendor">;

/** Scalar facets all share the same cardinality query and null label policy. */
const scalarFacetSpecs = {
  costType: { value: expense.costType },
  lineKind: { value: expense.lineKind },
  lineBasis: { value: expense.lineBasis },
  trade: { value: effectiveExpenseTradeSql() },
  future: {
    value: sql<string>`case when ${expense.future} then 'true' else 'false' end`,
  },
  productPresence: {
    value: sql<string>`case when ${expense.productId} is null then 'none' else 'has' end`,
  },
} as const satisfies Record<
  Exclude<FacetId, "project" | "vendor" | "orderIdPresence">,
  { value: SQLWrapper }
>;

type ScalarFacetId = keyof typeof scalarFacetSpecs;

export function isExpenseScalarFacet(id: FacetId): id is ScalarFacetId {
  return Object.hasOwn(scalarFacetSpecs, id);
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
  principalOnly: boolean,
): ExpenseAnalyzeBucket["filter"] => {
  const filter: ExpenseAnalyzeBucket["filter"] = {};
  if (principalOnly) filter.lineKind = "principal";
  switch (dimension) {
    case "trade":
      filter.trade = key;
      break;
    case "costType":
      filter.costType = key;
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

const hasPrincipalAxis = (input: ExpenseAnalyzeInput) =>
  input.rowDimension === "trade" ||
  input.rowDimension === "costType" ||
  input.columnDimension === "trade" ||
  input.columnDimension === "costType";

export const expenseAnalysisWhere = (
  where: SQL | undefined,
  input: ExpenseAnalyzeInput,
) =>
  hasPrincipalAxis(input)
    ? and(where, eq(expense.lineKind, "principal"))
    : where;

const aggregateForCost = (cost: SQL<number | null>) => ({
  actual: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${cost}) filter (where ${cost} > 0 and ${expense.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${cost}) filter (where ${cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

const analysisAggregateFields = (
  allocationScope: ExpenseAllocationProjectScope | undefined,
) =>
  allocationScope
    ? aggregateForCost(
        expenseAllocatedCostSql(sql`${expense.id}`, allocationScope),
      )
    : expenseAggregateFields();

async function scopeAggregate(
  db: Database,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
) {
  const rows = await getDb(db)
    .select(analysisAggregateFields(allocationScope))
    .from(expense)
    .where(where);
  return aggregate(rows[0]);
}

const allocationAggregateFields = () => ({
  actual: sql<number>`coalesce(sum(allocation."attributedCents"::bigint / 100.0) filter (where allocation."attributedCents"::bigint > 0 and ${expense.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(allocation."attributedCents"::bigint / 100.0) filter (where allocation."attributedCents"::bigint > 0 and ${expense.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(allocation."attributedCents"::bigint / 100.0) filter (where allocation."attributedCents"::bigint < 0), 0)::float`,
  net: sql<number>`coalesce(sum(allocation."attributedCents"::bigint) / 100.0, 0)::float`,
  count: sql<number>`count(distinct ${expense.id})::int`,
});

async function allocatedProjectAggregate(
  db: Database,
  where: SQL | undefined,
  projectCondition: SQL,
  allocationScope?: ExpenseAllocationProjectScope,
) {
  const rows = await getDb(db)
    .select(allocationAggregateFields())
    .from(expense)
    .innerJoin(
      sql`(${expenseProjectAllocationSql()}) allocation`,
      sql`allocation."expenseId" = ${expense.id}`,
    )
    .where(
      and(
        where,
        projectCondition,
        allocationScope
          ? expenseAllocationScopeConditionSql("allocation", allocationScope)
          : undefined,
      ),
    );
  return aggregate(rows[0]);
}

async function groupedDimension(
  db: Database,
  where: SQL | undefined,
  dimension: Dimension,
  allocationScope?: ExpenseAllocationProjectScope,
): Promise<BucketRow[]> {
  const database = getDb(db);
  const spec = dimensionSpecs[dimension];
  if (dimension === "project") {
    const rows = await database
      .select({
        key: project.shortcode,
        label: project.name,
        ...allocationAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        sql`(${expenseProjectAllocationSql()}) allocation`,
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
    return rows.map((row) => ({
      ...row,
      key: String(row.key),
      label: String(row.label),
    }));
  }
  const charge = alias(purchase, "analyzeDimensionCharge");
  const rows = await database
    .select({
      key: spec.key,
      label: spec.label,
      ...analysisAggregateFields(allocationScope),
    })
    .from(expense)
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
  return rows.map((row) => ({
    ...row,
    key: String(row.key),
    label: String(row.label),
  }));
}

async function groupedCells(
  db: Database,
  where: SQL | undefined,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension,
  allocationScope?: ExpenseAllocationProjectScope,
): Promise<CellRow[]> {
  const database = getDb(db);
  const row = dimensionSpecs[rowDimension];
  const column = dimensionColumns(columnDimension);
  if (rowDimension === "project") {
    const rows = await database
      .select({
        rowKey: project.shortcode,
        columnKey: column.key,
        ...allocationAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        sql`(${expenseProjectAllocationSql()}) allocation`,
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
      .groupBy(project.shortcode, column.key)
      .orderBy(project.shortcode, column.key);
    return rows.map((item) => ({
      ...item,
      rowKey: String(item.rowKey),
    }));
  }
  const charge = alias(purchase, "analyzeCellCharge");
  const rows = await database
    .select({
      rowKey: row.key,
      columnKey: column.key,
      ...analysisAggregateFields(allocationScope),
    })
    .from(expense)
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
  return rows.map((row) => ({ ...row, rowKey: String(row.rowKey) }));
}

export function previousExpenseFilters(filters: ExpenseFilters) {
  // The schema rejects unbounded comparison requests. This guard keeps the
  // repository sound for direct internal callers as well.
  if (!filters.dateFrom || !filters.dateTo) {
    throw new Error("Previous-period comparison requires dateFrom and dateTo");
  }
  const days =
    differenceInCalendarDays(
      parseISO(filters.dateTo),
      parseISO(filters.dateFrom),
    ) + 1;
  const dateTo = format(subDays(parseISO(filters.dateFrom), 1), "yyyy-MM-dd");
  const dateFrom = format(
    subDays(parseISO(filters.dateFrom), days),
    "yyyy-MM-dd",
  );
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
export function selectedExpenseFacetValues(
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

export function includeSelectedExpenseFacetZeroOptions(
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

export type ExpenseFacetOption =
  ExpenseFacetCountsOut["facets"][number]["options"][number];

async function scalarFacetOptions(
  db: Database,
  where: SQL | undefined,
  spec: (typeof scalarFacetSpecs)[keyof typeof scalarFacetSpecs],
): Promise<ExpenseFacetOption[]> {
  const rows = await getDb(db)
    .select({ value: spec.value, count: sql<number>`count(*)::int` })
    .from(expense)
    .where(where)
    .groupBy(spec.value);
  return rows.map((row) => ({
    value: String(row.value),
    label: null,
    count: Number(row.count),
  }));
}

/**
 * Facet entity buckets intentionally use the same live relation definition as
 * analyzer axes. Presence below remains raw-FK based, so it can distinguish a
 * linked row from no link without changing the existing filter semantics.
 */
async function entityFacetOptions(
  db: Database,
  where: SQL | undefined,
  dimension: "project" | "vendor",
): Promise<ExpenseFacetOption[]> {
  if (dimension === "project") {
    const rows = await getDb(db)
      .select({
        value: project.shortcode,
        label: project.name,
        count: sql<number>`count(distinct ${expense.id})::int`,
      })
      .from(expense)
      .innerJoin(
        sql`(${expenseProjectAllocationSql()}) allocation`,
        sql`allocation."expenseId" = ${expense.id}`,
      )
      .innerJoin(
        project,
        and(sql`${project.id} = allocation."projectId"`, notDeleted(project)),
      )
      .where(where)
      .groupBy(project.shortcode, project.name)
      .orderBy(project.name);
    return rows.map((row) => ({
      value: String(row.value),
      label: String(row.label),
      count: Number(row.count),
    }));
  }
  const spec = dimensionSpecs[dimension];
  const charge = alias(purchase, "facetDimensionCharge");
  const rows = await getDb(db)
    .select({
      value: spec.key,
      label: spec.label,
      count: sql<number>`count(*)::int`,
    })
    .from(expense)
    .leftJoin(
      project,
      and(eq(effectiveExpenseProjectSql(), project.id), notDeleted(project)),
    )
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .leftJoin(vendor, and(eq(charge.vendorId, vendor.id), notDeleted(vendor)))
    .where(and(where, isNotNull(spec.key)))
    .groupBy(spec.key, spec.label)
    .orderBy(spec.label);
  return rows.map((row) => ({
    value: String(row.value),
    label: String(row.label),
    count: Number(row.count),
  }));
}

async function presenceFacetOptions(
  db: Database,
  where: SQL | undefined,
  column: typeof expense.purchaseId,
): Promise<ExpenseFacetOption[]> {
  const [presence] = await getDb(db)
    .select({
      any: sql<number>`count(*) filter (where ${column} is not null)::int`,
      none: sql<number>`count(*) filter (where ${column} is null)::int`,
    })
    .from(expense)
    .where(where);
  return [
    { value: "__any__", label: null, count: presence?.any ?? 0 },
    { value: "__none__", label: null, count: presence?.none ?? 0 },
  ];
}

async function projectPresenceFacetOptions(
  db: Database,
  where: SQL | undefined,
): Promise<ExpenseFacetOption[]> {
  const [presence] = await getDb(db)
    .select({
      any: sql<number>`count(*) filter (where exists (
        select 1 from (${expenseProjectAllocationSql()}) allocation
        where allocation."expenseId" = ${expense.id}
          and allocation."projectId" is not null
      ))::int`,
      none: sql<number>`count(*) filter (where exists (
        select 1 from (${expenseProjectAllocationSql()}) allocation
        where allocation."expenseId" = ${expense.id}
          and allocation."projectId" is null
      ))::int`,
    })
    .from(expense)
    .where(where);
  return [
    { value: "__any__", label: null, count: presence?.any ?? 0 },
    { value: "__none__", label: null, count: presence?.none ?? 0 },
  ];
}

export type ExpenseAnalysisPeriod = {
  rows: BucketRow[];
  columns: BucketRow[];
  cells: CellRow[];
  scope: ExpenseAnalyzeAggregate;
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
  const rowsPromise = groupedDimension(
    db,
    gridWhere,
    rowDimension,
    allocationScope,
  );
  const [rows, columns, cells, scope] = await Promise.all([
    rowsPromise,
    columnDimension
      ? groupedDimension(db, gridWhere, columnDimension, allocationScope)
      : Promise.resolve([]),
    columnDimension
      ? groupedCells(
          db,
          gridWhere,
          rowDimension,
          columnDimension,
          allocationScope,
        )
      : rowsPromise.then(asOneDimensionCells),
    scopeAggregate(db, scopeWhere, allocationScope),
  ]);
  return { rows, columns, cells, scope };
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

export const loadExpenseAnalysisCauses = async (
  db: Database,
  input: ExpenseAnalyzeInput,
  where: SQL | undefined,
  allocationScope?: ExpenseAllocationProjectScope,
) => {
  const principalAxis = hasPrincipalAxis(input);
  const projectAxis = input.rowDimension === "project";
  const vendorAxis = input.rowDimension === "vendor";
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
  const [adjustments, unattributedProject, unattributedVendor] =
    await Promise.all([
      principalAxis
        ? scopeAggregate(
            db,
            and(where, ne(expense.lineKind, "principal")),
            allocationScope,
          )
        : Promise.resolve(zeroAggregate()),
      projectAxis
        ? allocatedProjectAggregate(
            db,
            where,
            sql`allocation."projectId" IS NULL`,
            allocationScope,
          )
        : Promise.resolve(zeroAggregate()),
      vendorAxis
        ? scopeAggregate(db, and(where, missingVendor), allocationScope)
        : Promise.resolve(zeroAggregate()),
    ]);
  return { adjustments, unattributedProject, unattributedVendor };
};

const projectAnalysisBuckets = (
  rows: Map<string, BucketRow>,
  dimension: Dimension,
  principalOnly: boolean,
) =>
  [...rows.values()].map((row) => ({
    key: row.key,
    label: row.label,
    filter: bucketFilter(dimension, row.key, principalOnly),
  }));

export type ExpenseAnalysisCauses = Awaited<
  ReturnType<typeof loadExpenseAnalysisCauses>
>;
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
  const gridCurrent = cells.reduce(
    (total, cell) => addAggregate(total, cell.current),
    zeroAggregate(),
  );
  const gridPrevious = comparison
    ? cells.reduce(
        (total, cell) => addAggregate(total, cell.previous ?? zeroAggregate()),
        zeroAggregate(),
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
    adjustments: analysisPair(
      currentCauses.adjustments,
      previousCauses?.adjustments ?? null,
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
  const principalOnly = hasPrincipalAxis(input);
  return {
    status: "ready",
    rowDimension: input.rowDimension,
    columnDimension: input.columnDimension ?? null,
    comparison: {
      mode: input.comparison,
      previousRange: comparison?.range ?? null,
    },
    rows: projectAnalysisBuckets(
      grid.rowMap,
      input.rowDimension,
      principalOnly,
    ),
    columns: input.columnDimension
      ? projectAnalysisBuckets(
          grid.columnMap,
          input.columnDimension,
          principalOnly,
        )
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

export const loadExpenseFacetWhere = async (
  db: Database,
  filters: ExpenseFilters,
  id: ExpenseFacetId,
) => buildExpenseWhereClause(db, emptyExpenseFacetFilters(filters, id));

export const loadExpenseScalarFacetOptions = (
  db: Database,
  where: SQL | undefined,
  id: ScalarFacetId,
) => scalarFacetOptions(db, where, scalarFacetSpecs[id]);

export const loadExpenseEntityFacetOptions = (
  db: Database,
  where: SQL | undefined,
  id: "project" | "vendor",
) => entityFacetOptions(db, where, id);

export const loadExpensePresenceFacetOptions = (
  db: Database,
  where: SQL | undefined,
  id: "project" | "vendor",
) =>
  id === "project"
    ? projectPresenceFacetOptions(db, where)
    : presenceFacetOptions(db, where, expense.purchaseId);

export const loadExpenseOrderIdFacetOptions = async (
  db: Database,
  where: SQL | undefined,
): Promise<ExpenseFacetOption[]> => {
  const charge = alias(purchase, "facetOrderCharge");
  const rows = await getDb(db)
    .select({
      value: sql<string>`case when ${charge.orderId} is null then 'none' else 'has' end`,
      count: sql<number>`count(*)::int`,
    })
    .from(expense)
    .leftJoin(
      charge,
      and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
    )
    .where(where)
    .groupBy(
      sql`case when ${charge.orderId} is null then 'none' else 'has' end`,
    );
  return rows.map((row) => ({ ...row, label: null }));
};
