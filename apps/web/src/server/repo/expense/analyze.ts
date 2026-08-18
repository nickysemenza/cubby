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
  isNull,
  ne,
  notExists,
  type SQL,
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
): Record<string, string> => {
  switch (dimension) {
    case "trade":
      return { trade: key };
    case "costType":
      return { costType: key };
    case "project":
      return { project: key };
    case "vendor":
      return { vendor: key };
    case "month":
      return {
        dateFrom: `${key}-01`,
        dateTo: format(endOfMonth(parseISO(`${key}-01`)), "yyyy-MM-dd"),
      };
  }
};

const dimensionColumns = (
  dimension: Exclude<Dimension, "project" | "vendor">,
) => {
  switch (dimension) {
    case "trade":
      return { key: expense.trade, label: expense.trade };
    case "costType":
      return { key: expense.costType, label: expense.costType };
    case "month":
      return { key: EXPENSE_MONTH_BUCKET, label: EXPENSE_MONTH_BUCKET };
  }
};

const hasPrincipalAxis = (input: ExpenseAnalyzeInput) =>
  input.rowDimension === "trade" ||
  input.rowDimension === "costType" ||
  input.columnDimension === "trade" ||
  input.columnDimension === "costType";

const analysisWhere = (where: SQL | undefined, input: ExpenseAnalyzeInput) =>
  hasPrincipalAxis(input)
    ? and(where, eq(expense.lineKind, "principal"))
    : where;

const gridWhere = (where: SQL | undefined, input: ExpenseAnalyzeInput) =>
  input.rowDimension === "month" || input.columnDimension === "month"
    ? and(where, isNotNull(expense.date))
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
  if (dimension === "project") {
    return await database
      .select({
        key: project.shortcode,
        label: project.name,
        ...expenseAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        project,
        and(eq(expense.projectId, project.id), notDeleted(project)),
      )
      .where(where)
      .groupBy(project.shortcode, project.name)
      .orderBy(project.name);
  }
  if (dimension === "vendor") {
    const charge = alias(purchase, "analyzeCharge");
    return await database
      .select({
        key: vendor.shortcode,
        label: vendor.name,
        ...expenseAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        charge,
        and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
      )
      .innerJoin(
        vendor,
        and(eq(charge.vendorId, vendor.id), notDeleted(vendor)),
      )
      .where(where)
      .groupBy(vendor.shortcode, vendor.name)
      .orderBy(vendor.name);
  }
  const columns = dimensionColumns(dimension);
  return await database
    .select({
      key: columns.key,
      label: columns.label,
      ...expenseAggregateFields(),
    })
    .from(expense)
    .where(where)
    .groupBy(columns.key, columns.label)
    .orderBy(columns.label);
}

async function groupedCells(
  db: Database,
  where: SQL | undefined,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension | null,
): Promise<CellRow[]> {
  if (!columnDimension) {
    const rows = await groupedDimension(db, where, rowDimension);
    return rows.map(({ key, ...row }) => ({
      ...row,
      rowKey: key,
      columnKey: null,
    }));
  }
  const database = getDb(db);
  const column = dimensionColumns(columnDimension);
  if (rowDimension === "project") {
    return await database
      .select({
        rowKey: project.shortcode,
        columnKey: column.key,
        ...expenseAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        project,
        and(eq(expense.projectId, project.id), notDeleted(project)),
      )
      .where(where)
      .groupBy(project.shortcode, column.key)
      .orderBy(project.shortcode, column.key);
  }
  if (rowDimension === "vendor") {
    const charge = alias(purchase, "analyzeCellCharge");
    return await database
      .select({
        rowKey: vendor.shortcode,
        columnKey: column.key,
        ...expenseAggregateFields(),
      })
      .from(expense)
      .innerJoin(
        charge,
        and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
      )
      .innerJoin(
        vendor,
        and(eq(charge.vendorId, vendor.id), notDeleted(vendor)),
      )
      .where(where)
      .groupBy(vendor.shortcode, column.key)
      .orderBy(vendor.shortcode, column.key);
  }
  const row = dimensionColumns(rowDimension);
  return await database
    .select({
      rowKey: row.key,
      columnKey: column.key,
      ...expenseAggregateFields(),
    })
    .from(expense)
    .where(where)
    .groupBy(row.key, column.key)
    .orderBy(row.key, column.key);
}

function previousFilters(filters: ExpenseFilters): {
  filters: ExpenseFilters;
  range: { dateFrom: string; dateTo: string };
} {
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
  const currentGridWhere = gridWhere(analyzedCurrentWhere, input);
  const previousGridWhere = gridWhere(analyzedPreviousWhere, input);

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
    groupedDimension(db, currentGridWhere, input.rowDimension),
    input.columnDimension
      ? groupedDimension(db, currentGridWhere, input.columnDimension)
      : Promise.resolve([]),
    groupedCells(
      db,
      currentGridWhere,
      input.rowDimension,
      input.columnDimension ?? null,
    ),
    scopeAggregate(db, currentWhere),
    comparison
      ? groupedDimension(db, previousGridWhere, input.rowDimension)
      : Promise.resolve([]),
    comparison && input.columnDimension
      ? groupedDimension(db, previousGridWhere, input.columnDimension)
      : Promise.resolve([]),
    comparison
      ? groupedCells(
          db,
          previousGridWhere,
          input.rowDimension,
          input.columnDimension ?? null,
        )
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
    const monthAxis =
      input.rowDimension === "month" || input.columnDimension === "month";
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
    const [adjustments, unattributedProject, unattributedVendor, undated] =
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
        monthAxis
          ? scopeAggregate(db, and(where, isNull(expense.date)))
          : Promise.resolve(zeroAggregate()),
      ]);
    return { adjustments, unattributedProject, unattributedVendor, undated };
  };
  const [currentCauses, previousCauses] = await Promise.all([
    causesFor(currentWhere),
    comparison ? causesFor(previousWhere) : Promise.resolve(null),
  ]);
  const pair = (
    current: ExpenseAnalyzeAggregate,
    previous: ExpenseAnalyzeAggregate | null,
  ) => ({ current, previous });

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
      filter: bucketFilter(input.rowDimension, row.key),
    })),
    columns: input.columnDimension
      ? [...columnMap.values()].map((column) => ({
          key: column.key,
          label: column.label,
          filter: bucketFilter(input.columnDimension!, column.key),
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
        undated: pair(currentCauses.undated, previousCauses?.undated ?? null),
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
      switch (id) {
        case "costType": {
          const rows = await database
            .select({
              value: expense.costType,
              count: sql<number>`count(*)::int`,
            })
            .from(expense)
            .where(where)
            .groupBy(expense.costType);
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "lineKind": {
          const rows = await database
            .select({
              value: expense.lineKind,
              count: sql<number>`count(*)::int`,
            })
            .from(expense)
            .where(where)
            .groupBy(expense.lineKind);
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "lineBasis": {
          const rows = await database
            .select({
              value: expense.lineBasis,
              count: sql<number>`count(*)::int`,
            })
            .from(expense)
            .where(where)
            .groupBy(expense.lineBasis);
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "trade": {
          const rows = await database
            .select({ value: expense.trade, count: sql<number>`count(*)::int` })
            .from(expense)
            .where(where)
            .groupBy(expense.trade);
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "future": {
          const rows = await database
            .select({
              value: sql<string>`case when ${expense.future} then 'true' else 'false' end`,
              count: sql<number>`count(*)::int`,
            })
            .from(expense)
            .where(where)
            .groupBy(expense.future);
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
        case "productPresence": {
          const rows = await database
            .select({
              value: sql<string>`case when ${expense.productId} is null then 'none' else 'has' end`,
              count: sql<number>`count(*)::int`,
            })
            .from(expense)
            .where(where)
            .groupBy(
              sql`case when ${expense.productId} is null then 'none' else 'has' end`,
            );
          return { id, options: rows.map((row) => ({ ...row, label: null })) };
        }
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
          const [rows, [presence]] = await Promise.all([
            database
              .select({
                value: project.shortcode,
                label: project.name,
                count: sql<number>`count(*)::int`,
              })
              .from(expense)
              .innerJoin(
                project,
                and(eq(expense.projectId, project.id), notDeleted(project)),
              )
              .where(where)
              .groupBy(project.shortcode, project.name)
              .orderBy(project.name),
            database
              .select({
                any: sql<number>`count(*) filter (where ${expense.projectId} is not null)::int`,
                none: sql<number>`count(*) filter (where ${expense.projectId} is null)::int`,
              })
              .from(expense)
              .where(where),
          ]);
          return {
            id,
            options: [
              { value: "__any__", label: null, count: presence?.any ?? 0 },
              { value: "__none__", label: null, count: presence?.none ?? 0 },
              ...rows,
            ],
          };
        }
        case "vendor": {
          const charge = alias(purchase, "facetVendorCharge");
          const [rows, [presence]] = await Promise.all([
            database
              .select({
                value: vendor.shortcode,
                label: vendor.name,
                count: sql<number>`count(*)::int`,
              })
              .from(expense)
              .innerJoin(
                charge,
                and(eq(expense.purchaseId, charge.id), notDeleted(charge)),
              )
              .innerJoin(
                vendor,
                and(eq(charge.vendorId, vendor.id), notDeleted(vendor)),
              )
              .where(where)
              .groupBy(vendor.shortcode, vendor.name)
              .orderBy(vendor.name),
            database
              .select({
                any: sql<number>`count(*) filter (where ${expense.purchaseId} is not null)::int`,
                none: sql<number>`count(*) filter (where ${expense.purchaseId} is null)::int`,
              })
              .from(expense)
              .where(where),
          ]);
          return {
            id,
            options: [
              { value: "__any__", label: null, count: presence?.any ?? 0 },
              { value: "__none__", label: null, count: presence?.none ?? 0 },
              ...rows,
            ],
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
