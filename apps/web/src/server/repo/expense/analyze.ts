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
type FacetId = ExpenseFacetCountsInput["facetIds"][number];

/**
 * The analyzer's closed set of axes. Project and vendor deliberately carry
 * their live-join requirement here: a dangling or soft-deleted relation is an
 * unattributed expense, not a bucket with a stale label.
 */
const dimensionSpecs = {
  trade: { key: expense.trade, label: expense.trade, relation: "expense" },
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
  trade: { value: expense.trade },
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

function isScalarFacetId(id: FacetId): id is ScalarFacetId {
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

const analysisWhere = (where: SQL | undefined, input: ExpenseAnalyzeInput) =>
  hasPrincipalAxis(input)
    ? and(where, eq(expense.lineKind, "principal"))
    : where;

async function scopeAggregate(db: Database, where: SQL | undefined) {
  const rows = await getDb(db)
    .select(expenseAggregateFields())
    .from(expense)
    .where(where);
  return aggregate(rows[0]);
}

async function groupedDimension(
  db: Database,
  where: SQL | undefined,
  dimension: Dimension,
): Promise<BucketRow[]> {
  const database = getDb(db);
  const spec = dimensionSpecs[dimension];
  const charge = alias(purchase, "analyzeDimensionCharge");
  const rows = await database
    .select({
      key: spec.key,
      label: spec.label,
      ...expenseAggregateFields(),
    })
    .from(expense)
    .leftJoin(
      project,
      and(eq(expense.projectId, project.id), notDeleted(project)),
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
): Promise<CellRow[]> {
  const database = getDb(db);
  const row = dimensionSpecs[rowDimension];
  const column = dimensionColumns(columnDimension);
  const charge = alias(purchase, "analyzeCellCharge");
  const rows = await database
    .select({
      rowKey: row.key,
      columnKey: column.key,
      ...expenseAggregateFields(),
    })
    .from(expense)
    .leftJoin(
      project,
      and(eq(expense.projectId, project.id), notDeleted(project)),
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

function previousFilters(filters: ExpenseFilters) {
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

function emptyFacetFilters(
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
function selectedFacetValues(
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

function includeSelectedZeroOptions(
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

type FacetOption = ExpenseFacetCountsOut["facets"][number]["options"][number];

async function scalarFacetOptions(
  db: Database,
  where: SQL | undefined,
  spec: (typeof scalarFacetSpecs)[keyof typeof scalarFacetSpecs],
): Promise<FacetOption[]> {
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
): Promise<FacetOption[]> {
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
      and(eq(expense.projectId, project.id), notDeleted(project)),
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
  column: typeof expense.projectId | typeof expense.purchaseId,
): Promise<FacetOption[]> {
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

export async function expenseAnalyze(
  db: Database,
  input: ExpenseAnalyzeInput,
): Promise<ExpenseAnalyzeOut> {
  const currentWhere = await buildExpenseWhereClause(db, input.filters);
  const analyzedCurrentWhere = analysisWhere(currentWhere, input);
  const comparison =
    input.comparison === "previousPeriod"
      ? previousFilters(input.filters)
      : null;
  const previousWhere = comparison
    ? await buildExpenseWhereClause(db, comparison.filters)
    : undefined;
  const analyzedPreviousWhere = comparison
    ? analysisWhere(previousWhere, input)
    : undefined;
  const currentGridWhere = analyzedCurrentWhere;
  const previousGridWhere = analyzedPreviousWhere;

  const currentRowsPromise = groupedDimension(
    db,
    currentGridWhere,
    input.rowDimension,
  );
  const previousRowsPromise = comparison
    ? groupedDimension(db, previousGridWhere, input.rowDimension)
    : Promise.resolve([]);
  const asOneDimensionCells = (rows: BucketRow[]): CellRow[] =>
    rows.map(({ key, ...row }) => ({
      ...row,
      rowKey: key,
      columnKey: null,
    }));

  const [
    currentRows,
    currentColumns,
    currentCells,
    currentScope,
    previousRows,
    previousColumns,
    previousCells,
    previousScope,
  ] = await Promise.all([
    currentRowsPromise,
    input.columnDimension
      ? groupedDimension(db, currentGridWhere, input.columnDimension)
      : Promise.resolve([]),
    input.columnDimension
      ? groupedCells(
          db,
          currentGridWhere,
          input.rowDimension,
          input.columnDimension,
        )
      : currentRowsPromise.then(asOneDimensionCells),
    scopeAggregate(db, currentWhere),
    previousRowsPromise,
    comparison && input.columnDimension
      ? groupedDimension(db, previousGridWhere, input.columnDimension)
      : Promise.resolve([]),
    comparison && input.columnDimension
      ? groupedCells(
          db,
          previousGridWhere,
          input.rowDimension,
          input.columnDimension,
        )
      : comparison
        ? previousRowsPromise.then(asOneDimensionCells)
        : Promise.resolve([]),
    comparison ? scopeAggregate(db, previousWhere) : Promise.resolve(null),
  ]);

  const rowMap = new Map(
    [...currentRows, ...previousRows].map((row) => [row.key, row]),
  );
  const columnMap = new Map(
    [...currentColumns, ...previousColumns].map((row) => [row.key, row]),
  );
  if (rowMap.size > ROW_LIMIT)
    return {
      status: "too_large",
      reason: "row_limit",
      limit: ROW_LIMIT,
      observedAtLeast: rowMap.size,
    };
  if (input.columnDimension === "month" && columnMap.size > MONTH_COLUMN_LIMIT)
    return {
      status: "too_large",
      reason: "month_column_limit",
      limit: MONTH_COLUMN_LIMIT,
      observedAtLeast: columnMap.size,
    };

  const currentCellMap = new Map(
    currentCells.map((cell) => [
      `${cell.rowKey}\u0000${cell.columnKey ?? ""}`,
      cell,
    ]),
  );
  const previousCellMap = new Map(
    previousCells.map((cell) => [
      `${cell.rowKey}\u0000${cell.columnKey ?? ""}`,
      cell,
    ]),
  );
  const cellKeys = new Set([
    ...currentCellMap.keys(),
    ...previousCellMap.keys(),
  ]);
  if (cellKeys.size > CELL_LIMIT)
    return {
      status: "too_large",
      reason: "cell_limit",
      limit: CELL_LIMIT,
      observedAtLeast: cellKeys.size,
    };

  const cells = [...cellKeys].map((key) => {
    const current = currentCellMap.get(key);
    const previous = previousCellMap.get(key);
    const exemplar = current ?? previous!;
    return {
      rowKey: exemplar.rowKey,
      columnKey: exemplar.columnKey,
      current: aggregate(current),
      previous: comparison ? aggregate(previous) : null,
    };
  });
  const gridCurrent = cells.reduce(
    (total, cell) => addAggregate(total, cell.current),
    zeroAggregate(),
  );
  const gridPrevious = comparison
    ? cells.reduce(
        (total, cell) => addAggregate(total, cell.previous!),
        zeroAggregate(),
      )
    : null;

  const causesFor = async (where: SQL | undefined) => {
    const principalAxis = hasPrincipalAxis(input);
    const projectAxis = input.rowDimension === "project";
    const vendorAxis = input.rowDimension === "vendor";
    const missingProject = notExists(
      getDb(db)
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.id, expense.projectId), notDeleted(project))),
    );
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
          ? scopeAggregate(db, and(where, ne(expense.lineKind, "principal")))
          : Promise.resolve(zeroAggregate()),
        projectAxis
          ? scopeAggregate(db, and(where, missingProject))
          : Promise.resolve(zeroAggregate()),
        vendorAxis
          ? scopeAggregate(db, and(where, missingVendor))
          : Promise.resolve(zeroAggregate()),
      ]);
    return { adjustments, unattributedProject, unattributedVendor };
  };
  const [currentCauses, previousCauses] = await Promise.all([
    causesFor(currentWhere),
    comparison ? causesFor(previousWhere) : Promise.resolve(null),
  ]);
  const pair = (
    current: ExpenseAnalyzeAggregate,
    previous: ExpenseAnalyzeAggregate | null,
  ) => ({ current, previous });
  const principalOnly = hasPrincipalAxis(input);

  return {
    status: "ready",
    rowDimension: input.rowDimension,
    columnDimension: input.columnDimension ?? null,
    comparison: {
      mode: input.comparison,
      previousRange: comparison?.range ?? null,
    },
    rows: [...rowMap.values()].map((row) => ({
      key: row.key,
      label: row.label,
      filter: bucketFilter(input.rowDimension, row.key, principalOnly),
    })),
    columns: input.columnDimension
      ? [...columnMap.values()].map((column) => ({
          key: column.key,
          label: column.label,
          filter: bucketFilter(
            input.columnDimension!,
            column.key,
            principalOnly,
          ),
        }))
      : [],
    cells,
    totals: {
      scope: pair(currentScope, previousScope),
      grid: pair(gridCurrent, gridPrevious),
    },
    reconciliation: {
      tail: pair(
        subtractAggregate(currentScope, gridCurrent),
        previousScope && gridPrevious
          ? subtractAggregate(previousScope, gridPrevious)
          : null,
      ),
      causes: {
        adjustments: pair(
          currentCauses.adjustments,
          previousCauses?.adjustments ?? null,
        ),
        unattributedProject: pair(
          currentCauses.unattributedProject,
          previousCauses?.unattributedProject ?? null,
        ),
        unattributedVendor: pair(
          currentCauses.unattributedVendor,
          previousCauses?.unattributedVendor ?? null,
        ),
      },
    },
  };
}

export async function expenseFacetCounts(
  db: Database,
  input: ExpenseFacetCountsInput,
): Promise<ExpenseFacetCountsOut> {
  const facets = await Promise.all(
    input.facetIds.map(async (id) => {
      const where = await buildExpenseWhereClause(
        db,
        emptyFacetFilters(input.filters, id),
      );
      const database = getDb(db);
      if (isScalarFacetId(id)) {
        return {
          id,
          options: await scalarFacetOptions(db, where, scalarFacetSpecs[id]),
        };
      }
      switch (id) {
        case "orderIdPresence": {
          const charge = alias(purchase, "facetOrderCharge");
          const rows = await database
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
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "project": {
          const [rows, presence] = await Promise.all([
            entityFacetOptions(db, where, "project"),
            presenceFacetOptions(db, where, expense.projectId),
          ]);
          return {
            id,
            options: [...presence, ...rows],
          };
        }
        case "vendor": {
          const [rows, presence] = await Promise.all([
            entityFacetOptions(db, where, "vendor"),
            presenceFacetOptions(db, where, expense.purchaseId),
          ]);
          return {
            id,
            options: [...presence, ...rows],
          };
        }
      }
    }),
  );
  return {
    facets: facets.map((facet) => ({
      ...facet,
      options: includeSelectedZeroOptions(
        facet.options,
        selectedFacetValues(input.filters, facet.id),
      ),
    })),
  };
}
