import type {
  ExpenseAnalyzeAggregate,
  ExpenseAnalyzeColumnDimension,
  ExpenseAnalyzeComparison,
  ExpenseAnalyzeOut,
  ExpenseAnalyzeReadyOut,
  ExpenseAnalyzeRowDimension,
  ExpenseFilters,
} from "@cubby/schemas/project";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { DownloadIcon } from "@phosphor-icons/react/dist/csr/Download";
import { useQuery } from "@tanstack/react-query";
import type { CellData, SortingState } from "@tanstack/react-table";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { useTableColumnLayout } from "~/app/_components/data-table/column-layout";
import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { Row, Stack } from "~/components/layout";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { copyText } from "~/lib/clipboard";
import { cn, formatCount, formatCurrency, formatPercent } from "~/lib/utils";

import {
  canSwapExpenseAnalyzeAxes,
  DEFAULT_EXPENSE_ANALYZE_CONFIG,
  type ExpenseAnalyzeConfig,
  type ExpenseAnalyzeMetric,
  type ExpenseAnalyzeProjection,
  normalizeExpenseAnalyzeConfig,
  swapExpenseAnalyzeAxes,
} from "./expense-analyze-config";
import {
  expenseAnalyzeCsv,
  expenseAnalyzeCsvFilename,
} from "./expense-analyze-csv";
import { expense } from "./expense.functions";

const METRICS: readonly { value: ExpenseAnalyzeMetric; label: string }[] = [
  { value: "net", label: "Net" },
  { value: "actual", label: "Actual" },
  { value: "committed", label: "Committed" },
  { value: "credits", label: "Credits" },
  { value: "count", label: "Count" },
];

const ROW_DIMENSIONS: readonly {
  value: ExpenseAnalyzeRowDimension;
  label: string;
}[] = [
  { value: "trade", label: "Trade" },
  { value: "costType", label: "Cost category" },
  { value: "month", label: "Month" },
  { value: "project", label: "Project" },
  { value: "vendor", label: "Vendor" },
];

const COLUMN_DIMENSIONS: readonly {
  value: ExpenseAnalyzeColumnDimension;
  label: string;
}[] = [
  { value: "trade", label: "Trade" },
  { value: "costType", label: "Cost category" },
  { value: "month", label: "Month" },
];

const PROJECTIONS: readonly {
  value: ExpenseAnalyzeProjection;
  label: string;
}[] = [
  { value: "current", label: "Current" },
  { value: "previous", label: "Previous" },
  { value: "delta", label: "Delta" },
  { value: "percent", label: "Delta %" },
];

const EMPTY_AGGREGATE: ExpenseAnalyzeAggregate = {
  actual: 0,
  committed: 0,
  credits: 0,
  net: 0,
  count: 0,
};

function ExpenseAnalysisResult({
  isLoading,
  isError,
  data,
  filters,
  metric,
  projection,
  onRetry,
  onOpenLedger,
}: {
  isLoading: boolean;
  isError: boolean;
  data: ExpenseAnalyzeOut | undefined;
  filters: ExpenseFilters;
  metric: ExpenseAnalyzeMetric;
  projection: ExpenseAnalyzeProjection;
  onRetry: () => void;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  if (isLoading) {
    return (
      <output
        className="h-52 animate-pulse bg-muted"
        aria-label="Loading analysis"
      />
    );
  }
  if (isError) {
    return (
      <Row
        align="center"
        gap="sm"
        className="border border-destructive/30 p-4 text-sm"
      >
        Couldn&apos;t load this analysis.
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </Row>
    );
  }
  if (data?.status === "too_large") {
    return (
      <div className="border border-border p-4 text-sm">
        This analysis has at least {formatCount(data.observedAtLeast)} buckets,
        beyond its {formatCount(data.limit)} bucket limit. Narrow the Ledger
        filters and try again.
      </div>
    );
  }
  if (!data) return null;
  if (data.rows.length === 0) {
    return (
      <div className="border border-border p-4 text-sm">
        No aggregate buckets match the current Ledger filters.
      </div>
    );
  }
  if (data.columnDimension) {
    return (
      <ExpenseAnalyzeCrossTab
        data={data}
        filters={filters}
        metric={metric}
        projection={
          data.comparison.mode === "previousPeriod" ? projection : "current"
        }
        onOpenLedger={onOpenLedger}
      />
    );
  }
  return (
    <ExpenseAnalyzeOneDimension
      key={data.comparison.mode}
      data={data}
      filters={filters}
      comparison={data.comparison.mode}
      metric={metric}
      onOpenLedger={onOpenLedger}
    />
  );
}

function selectedOptionValue<TValue extends string>(
  value: string,
  options: readonly { value: TValue }[],
): TValue | undefined {
  return options.find((option) => option.value === value)?.value;
}

type ExpenseAnalyzeRequest = Parameters<typeof expense.analyze.queryOptions>[0];
type ExpenseAnalyzeQuery = ReturnType<typeof expense.analyze.queryOptions>;

interface ExpenseAnalysisDownload {
  filename: string;
  content: string;
}

export interface ExpenseAggregateExplorerOperations {
  analyze: (request: ExpenseAnalyzeRequest) => ExpenseAnalyzeQuery;
  browser: {
    copyText: (value: string) => Promise<boolean>;
    downloadCsv: (download: ExpenseAnalysisDownload) => void;
  };
}

function downloadExpenseAnalysisCsv({
  filename,
  content,
}: ExpenseAnalysisDownload) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const productionOperations: ExpenseAggregateExplorerOperations = {
  analyze: expense.analyze.queryOptions,
  browser: { copyText, downloadCsv: downloadExpenseAnalysisCsv },
};

export interface ExpenseAnalyzeTableRow {
  id: string;
  label: string;
  filter: Record<string, string>;
  current: ExpenseAnalyzeAggregate;
  previous: ExpenseAnalyzeAggregate | null;
}

export function initialExpenseAnalyzeSorting(
  comparison: ExpenseAnalyzeComparison,
): SortingState {
  return [{ id: comparison === "none" ? "net" : "current", desc: true }];
}

export function expenseAnalyzeDrilldownFilter(
  data: ExpenseAnalyzeReadyOut,
  projection: ExpenseAnalyzeProjection,
  axisFilter: Record<string, string>,
): Record<string, string> | null {
  if (projection === "current") return axisFilter;
  if (projection !== "previous" || !data.comparison.previousRange) return null;
  return { ...axisFilter, ...data.comparison.previousRange };
}

function addAggregate(
  left: ExpenseAnalyzeAggregate,
  right: ExpenseAnalyzeAggregate,
): ExpenseAnalyzeAggregate {
  return {
    actual: left.actual + right.actual,
    committed: left.committed + right.committed,
    credits: left.credits + right.credits,
    net: left.net + right.net,
    count: left.count + right.count,
  };
}

function valueForProjection(
  current: number,
  previous: number | null,
  projection: ExpenseAnalyzeProjection,
) {
  if (projection === "current") return current;
  if (projection === "previous") return previous;
  if (previous === null) return null;
  if (projection === "delta") return current - previous;
  if (previous === 0) return current === 0 ? null : Number.POSITIVE_INFINITY;
  return (current - previous) / Math.abs(previous);
}

function formatMetric(value: number | null, metric: ExpenseAnalyzeMetric) {
  if (value === null) return "—";
  return metric === "count" ? formatCount(value) : formatCurrency(value);
}

export function formatExpenseAnalyzeValue(
  current: number,
  previous: number | null,
  metric: ExpenseAnalyzeMetric,
  projection: ExpenseAnalyzeProjection,
) {
  const value = valueForProjection(current, previous, projection);
  if (projection !== "percent") return formatMetric(value, metric);
  if (value === null) return "—";
  if (value === Number.POSITIVE_INFINITY) return "New";
  return formatPercent(value, { signDisplay: "exceptZero" });
}

export function canCompareExpenseAnalysis(
  filters: Pick<ExpenseFilters, "dateFrom" | "dateTo">,
  rowDimension: ExpenseAnalyzeRowDimension,
  columnDimension: ExpenseAnalyzeColumnDimension | null,
) {
  return Boolean(
    filters.dateFrom &&
    filters.dateTo &&
    rowDimension !== "month" &&
    columnDimension !== "month",
  );
}

export function buildExpenseAnalyzeTableRows(
  data: ExpenseAnalyzeReadyOut,
): ExpenseAnalyzeTableRow[] {
  const currentByRow = new Map<string, ExpenseAnalyzeAggregate>();
  const previousByRow = new Map<string, ExpenseAnalyzeAggregate | null>();
  for (const cell of data.cells) {
    currentByRow.set(
      cell.rowKey,
      addAggregate(
        currentByRow.get(cell.rowKey) ?? EMPTY_AGGREGATE,
        cell.current,
      ),
    );
    if (cell.previous) {
      previousByRow.set(
        cell.rowKey,
        addAggregate(
          previousByRow.get(cell.rowKey) ?? EMPTY_AGGREGATE,
          cell.previous,
        ),
      );
    } else if (!previousByRow.has(cell.rowKey)) {
      previousByRow.set(cell.rowKey, null);
    }
  }
  return data.rows.map((bucket) => ({
    id: bucket.key,
    label: bucket.label,
    filter: bucket.filter,
    current: currentByRow.get(bucket.key) ?? EMPTY_AGGREGATE,
    previous: previousByRow.get(bucket.key) ?? null,
  }));
}

function tailLabel(data: ExpenseAnalyzeReadyOut) {
  if (data.columnDimension || data.rowDimension === "month")
    return "Not represented in this grid";
  if (data.rowDimension === "project") return "Unattributed to a project";
  if (data.rowDimension === "vendor") return "Unattributed to a vendor";
  return "Purchase adjustments";
}

export function expenseAnalyzeGridTotalFilter(
  data: ExpenseAnalyzeReadyOut,
  filters: Pick<ExpenseFilters, "dateFrom" | "dateTo" | "dateRelative"> = {},
): Record<string, string> | null {
  if (data.rowDimension === "project" || data.rowDimension === "vendor") {
    return null;
  }
  const principalOnly =
    data.rowDimension === "trade" ||
    data.rowDimension === "costType" ||
    data.columnDimension === "trade" ||
    data.columnDimension === "costType";
  const filter: Record<string, string> = principalOnly
    ? { lineKind: "principal" }
    : {};
  const monthBuckets =
    data.rowDimension === "month"
      ? data.rows
      : data.columnDimension === "month"
        ? data.columns
        : [];
  const dateAlreadyBound = Boolean(
    filters.dateFrom || filters.dateTo || filters.dateRelative,
  );
  if (monthBuckets.length > 0 && !dateAlreadyBound) {
    const dateFrom = monthBuckets.at(0)?.filter.dateFrom;
    const dateTo = monthBuckets.at(-1)?.filter.dateTo;
    if (!dateFrom || !dateTo) return null;
    filter.dateFrom = dateFrom;
    filter.dateTo = dateTo;
  }
  return filter;
}

function AnalyzeLedgerValue({
  children,
  filter,
  label,
  onOpenLedger,
  className,
}: {
  children: React.ReactNode;
  filter: Record<string, string> | null;
  label: string;
  onOpenLedger: (filter: Record<string, string>) => void;
  className?: string;
}) {
  if (!filter) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      className={cn(
        "underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
      aria-label={label}
      onClick={() => onOpenLedger(filter)}
    >
      {children}
    </button>
  );
}

function ReconciliationNote({
  data,
  filters,
  metric,
  onOpenLedger,
}: {
  data: ExpenseAnalyzeReadyOut;
  filters: ExpenseFilters;
  metric: ExpenseAnalyzeMetric;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const causeEntries: [
    string,
    ExpenseAnalyzeReadyOut["reconciliation"]["causes"]["adjustments"],
  ][] = [
    ["Adjustments", data.reconciliation.causes.adjustments],
    ["Unattributed project", data.reconciliation.causes.unattributedProject],
    ["Unattributed vendor", data.reconciliation.causes.unattributedVendor],
  ];
  const causes = causeEntries.filter(
    ([, value]) =>
      value.current[metric] !== 0 || (value.previous?.[metric] ?? 0) !== 0,
  );
  const renderPeriodTotals = (
    label: string,
    value: {
      current: ExpenseAnalyzeAggregate;
      previous: ExpenseAnalyzeAggregate | null;
    },
    filter: Record<string, string> | null,
  ) => (
    <>
      {label}{" "}
      <AnalyzeLedgerValue
        filter={expenseAnalyzeDrilldownFilter(data, "current", filter ?? {})}
        label={`Open current-period ${label.toLowerCase()} in the Ledger`}
        onOpenLedger={onOpenLedger}
      >
        {formatMetric(value.current[metric], metric)}
      </AnalyzeLedgerValue>
      {value.previous && (
        <>
          {" "}
          (previous{" "}
          <AnalyzeLedgerValue
            filter={expenseAnalyzeDrilldownFilter(
              data,
              "previous",
              filter ?? {},
            )}
            label={`Open previous-period ${label.toLowerCase()} in the Ledger`}
            onOpenLedger={onOpenLedger}
          >
            {formatMetric(value.previous[metric], metric)}
          </AnalyzeLedgerValue>
          )
        </>
      )}
    </>
  );
  const current = (value: { current: ExpenseAnalyzeAggregate }) =>
    formatMetric(value.current[metric], metric);
  const gridFilter = expenseAnalyzeGridTotalFilter(data, filters);

  return (
    <Stack gap="xs" className="text-xs text-muted-foreground">
      <p>
        {renderPeriodTotals("Scope total", data.totals.scope, {})} ·{" "}
        {gridFilter
          ? renderPeriodTotals("Grid total", data.totals.grid, gridFilter)
          : `Grid total ${current(data.totals.grid)}`}{" "}
        · {tailLabel(data).toLowerCase()} {current(data.reconciliation.tail)}.
      </p>
      {causes.length > 0 && (
        <p>
          Explanations (may overlap):{" "}
          {causes
            .map(([label, value]) => `${label} ${current(value)}`)
            .join(" · ")}
          .
        </p>
      )}
    </Stack>
  );
}

const helper = createCubbyColumnHelper<ExpenseAnalyzeTableRow>();

function ExpenseAnalyzeOneDimension({
  data,
  filters,
  comparison,
  metric,
  onOpenLedger,
}: {
  data: ExpenseAnalyzeReadyOut;
  filters: ExpenseFilters;
  comparison: ExpenseAnalyzeComparison;
  metric: ExpenseAnalyzeMetric;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(() =>
    initialExpenseAnalyzeSorting(comparison),
  );
  const rows = useMemo(() => buildExpenseAnalyzeTableRows(data), [data]);
  const columns = useMemo(() => {
    const numericMeta = { numeric: true, mono: true } as const;
    const tail = data.reconciliation.tail;
    const addRegularColumn = (
      add: <TValue extends CellData>(
        definition: CubbyColumnDef<ExpenseAnalyzeTableRow, TValue>,
      ) => void,
      accessor: ExpenseAnalyzeMetric,
      label: string,
    ) =>
      add(
        helper.accessor((row) => row.current[accessor], {
          id: accessor,
          header: label,
          size: accessor === "count" ? 88 : 128,
          minSize: accessor === "count" ? 72 : 104,
          meta: numericMeta,
          cell: (info) => (
            <AnalyzeLedgerValue
              filter={expenseAnalyzeDrilldownFilter(
                data,
                "current",
                info.row.original.filter,
              )}
              label={`Open current-period Ledger rows for ${info.row.original.label}`}
              onOpenLedger={onOpenLedger}
              className="w-full text-right"
            >
              {formatMetric(info.getValue(), accessor)}
            </AnalyzeLedgerValue>
          ),
          footer: () => formatMetric(tail.current[accessor], accessor),
          enableCellSelection: false,
        }),
      );
    const compareColumn = (
      id: string,
      header: string,
      projection: ExpenseAnalyzeProjection,
    ) =>
      helper.accessor(
        (row) =>
          valueForProjection(
            row.current[metric],
            row.previous?.[metric] ?? null,
            projection,
          ),
        {
          id,
          header,
          size: projection === "percent" ? 96 : 122,
          minSize: projection === "percent" ? 84 : 100,
          meta: numericMeta,
          cell: (info) => {
            const display =
              projection === "percent"
                ? formatExpenseAnalyzeValue(
                    info.row.original.current[metric],
                    info.row.original.previous?.[metric] ?? null,
                    metric,
                    projection,
                  )
                : formatMetric(info.getValue(), metric);
            return (
              <AnalyzeLedgerValue
                filter={expenseAnalyzeDrilldownFilter(
                  data,
                  projection,
                  info.row.original.filter,
                )}
                label={`Open ${projection}-period Ledger rows for ${info.row.original.label}`}
                onOpenLedger={onOpenLedger}
                className="w-full text-right"
              >
                {display}
              </AnalyzeLedgerValue>
            );
          },
          footer: () =>
            formatExpenseAnalyzeValue(
              tail.current[metric],
              tail.previous?.[metric] ?? null,
              metric,
              projection,
            ),
          enableCellSelection: false,
        },
      );
    const labelColumn = helper.accessor("label", {
      header: "Label",
      size: 260,
      minSize: 160,
      footer: () => tailLabel(data),
      enableCellSelection: false,
    });
    return createCubbyColumnCollection<ExpenseAnalyzeTableRow>((add) => {
      add(labelColumn);
      if (comparison === "none") {
        for (const { value, label } of METRICS)
          addRegularColumn(add, value, label);
        return;
      }
      add(compareColumn("current", "Current", "current"));
      add(compareColumn("previous", "Previous", "previous"));
      add(compareColumn("delta", "Delta", "delta"));
      add(compareColumn("percent", "Delta %", "percent"));
    });
  }, [comparison, data, metric, onOpenLedger]);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
      pagination: { pageIndex: 0, pageSize: 500 },
    },
    meta: { defaultLayout },
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: setSorting,
    enableCellSelection: false,
  });

  return (
    <Stack gap="sm">
      <RTable
        table={table}
        embedded
        showColumnMenu
        ariaLabel="Expense analysis"
        emptyState="No aggregate buckets match the current ledger filters."
      />
      <ReconciliationNote
        data={data}
        filters={filters}
        metric={comparison === "none" ? "net" : metric}
        onOpenLedger={onOpenLedger}
      />
    </Stack>
  );
}

function cellLookup(data: ExpenseAnalyzeReadyOut) {
  return new Map(
    data.cells.map((cell) => [`${cell.rowKey}:${cell.columnKey ?? ""}`, cell]),
  );
}

function aggregateCells(
  cells: readonly {
    current: ExpenseAnalyzeAggregate;
    previous: ExpenseAnalyzeAggregate | null;
  }[],
) {
  return cells.reduce<{
    current: ExpenseAnalyzeAggregate;
    previous: ExpenseAnalyzeAggregate | null;
  }>(
    (result, cell) => ({
      current: addAggregate(result.current, cell.current),
      previous: cell.previous
        ? addAggregate(result.previous ?? EMPTY_AGGREGATE, cell.previous)
        : result.previous,
    }),
    {
      current: EMPTY_AGGREGATE,
      previous: null,
    },
  );
}

function ExpenseAnalyzeCrossTab({
  data,
  filters,
  metric,
  projection,
  onOpenLedger,
}: {
  data: ExpenseAnalyzeReadyOut;
  filters: ExpenseFilters;
  metric: ExpenseAnalyzeMetric;
  projection: ExpenseAnalyzeProjection;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const cells = useMemo(() => cellLookup(data), [data]);
  const rowTotals = useMemo(
    () =>
      new Map(
        data.rows.map((row) => [
          row.key,
          aggregateCells(data.cells.filter((cell) => cell.rowKey === row.key)),
        ]),
      ),
    [data],
  );
  const columnTotals = useMemo(
    () =>
      new Map(
        data.columns.map((column) => [
          column.key,
          aggregateCells(
            data.cells.filter((cell) => cell.columnKey === column.key),
          ),
        ]),
      ),
    [data],
  );
  const exactGridFilter = expenseAnalyzeGridTotalFilter(data, filters);
  const heatMax = useMemo(() => {
    const values = data.cells
      .map((cell) =>
        valueForProjection(
          cell.current[metric],
          cell.previous?.[metric] ?? null,
          projection,
        ),
      )
      .filter(
        (value): value is number => value !== null && Number.isFinite(value),
      )
      .map(Math.abs);
    return Math.max(...values, 0);
  }, [data.cells, metric, projection]);
  const display = (
    current: ExpenseAnalyzeAggregate,
    previous: ExpenseAnalyzeAggregate | null,
  ) =>
    formatExpenseAnalyzeValue(
      current[metric],
      previous?.[metric] ?? null,
      metric,
      projection,
    );
  const heatClass = (
    current: ExpenseAnalyzeAggregate,
    previous: ExpenseAnalyzeAggregate | null,
  ) => {
    const value = valueForProjection(
      current[metric],
      previous?.[metric] ?? null,
      projection,
    );
    if (value === null || !Number.isFinite(value) || heatMax === 0)
      return undefined;
    const strength = Math.abs(value) / heatMax;
    const tone =
      strength > 0.66
        ? "bg-primary/15"
        : strength > 0.33
          ? "bg-primary/10"
          : "bg-primary/5";
    return value < 0 ? tone.replace("bg-primary", "bg-destructive") : tone;
  };

  return (
    <Stack gap="sm">
      <CrossTabTable
        caption="Expense analysis"
        cornerLabel="Rows"
        columns={data.columns.map((column) => ({
          key: column.key,
          data: column,
        }))}
        rows={data.rows.map((row) => ({ key: row.key, data: row }))}
        layout={{ rowHeader: 260, column: 124, pinned: 124 }}
        renderColumnHeader={(column) => column.data.label}
        renderRowHeader={(row) => row.data.label}
        renderCell={(row, column) => {
          const cell = cells.get(`${row.key}:${column.key}`);
          if (!cell) return null;
          const drilldown = expenseAnalyzeDrilldownFilter(data, projection, {
            ...row.data.filter,
            ...column.data.filter,
          });
          const className = cn(
            "block w-full px-2 py-2 text-right",
            heatClass(cell.current, cell.previous),
          );
          return drilldown ? (
            <button
              type="button"
              className={cn(
                className,
                "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              )}
              onClick={() => onOpenLedger(drilldown)}
            >
              {display(cell.current, cell.previous)}
            </button>
          ) : (
            <span className={className}>
              {display(cell.current, cell.previous)}
            </span>
          );
        }}
        bareCells
        rowHover
        pinned={[{ key: "total", label: "Total", stickyRight: "right-0" }]}
        renderPinnedCell={(row) => {
          const total = rowTotals.get(row.key);
          if (!total) return "—";
          return (
            <AnalyzeLedgerValue
              filter={expenseAnalyzeDrilldownFilter(
                data,
                projection,
                row.data.filter,
              )}
              label={`Open ${projection}-period Ledger rows for ${row.data.label}`}
              onOpenLedger={onOpenLedger}
              className="block w-full px-2 py-2 text-right"
            >
              {display(total.current, total.previous)}
            </AnalyzeLedgerValue>
          );
        }}
        footer={[
          {
            key: "grid-total",
            label: "Grid total",
            emphasis: "rule",
            cell: (columnKey) => {
              const total = columnTotals.get(columnKey);
              const column = data.columns.find(
                (candidate) => candidate.key === columnKey,
              );
              if (!total || !column) return "—";
              return (
                <AnalyzeLedgerValue
                  filter={
                    exactGridFilter
                      ? expenseAnalyzeDrilldownFilter(
                          data,
                          projection,
                          column.filter,
                        )
                      : null
                  }
                  label={`Open ${projection}-period Ledger rows for ${column.label}`}
                  onOpenLedger={onOpenLedger}
                  className="w-full text-right"
                >
                  {display(total.current, total.previous)}
                </AnalyzeLedgerValue>
              );
            },
            pinnedCell: () => (
              <AnalyzeLedgerValue
                filter={
                  exactGridFilter
                    ? expenseAnalyzeDrilldownFilter(
                        data,
                        projection,
                        exactGridFilter,
                      )
                    : null
                }
                label={`Open ${projection}-period grid total in the Ledger`}
                onOpenLedger={onOpenLedger}
                className="w-full text-right"
              >
                {display(data.totals.grid.current, data.totals.grid.previous)}
              </AnalyzeLedgerValue>
            ),
          },
        ]}
      />
      <ReconciliationNote
        data={data}
        filters={filters}
        metric={metric}
        onOpenLedger={onOpenLedger}
      />
      <p className="text-xs text-muted-foreground">
        {projection === "delta" || projection === "percent"
          ? "Delta views combine two periods. Show Current or Previous to open exact Ledger rows."
          : `Click a populated cell to open its exact ${projection === "previous" ? "previous-period" : "current-period"} Ledger rows.`}
      </p>
    </Stack>
  );
}

export function ExpenseAggregateExplorer({
  filters,
  config,
  onConfigChange,
  onOpenLedger,
  operations = productionOperations,
}: {
  filters: ExpenseFilters;
  config: ExpenseAnalyzeConfig;
  onConfigChange: (config: ExpenseAnalyzeConfig) => void;
  onOpenLedger: (filter: Record<string, string>) => void;
  operations?: ExpenseAggregateExplorerOperations;
}) {
  const { rowDimension, columnDimension, comparison, metric, projection } =
    config;
  const rowsId = useId();
  const columnsId = useId();
  const metricId = useId();
  const compareId = useId();
  const projectionId = useId();
  const comparisonAllowed = canCompareExpenseAnalysis(
    filters,
    rowDimension,
    columnDimension,
  );
  const query = useQuery({
    ...operations.analyze({
      filters,
      rowDimension,
      columnDimension,
      comparison,
    }),
  });
  const resetConfig = normalizeExpenseAnalyzeConfig(
    DEFAULT_EXPENSE_ANALYZE_CONFIG,
    filters,
  );
  const isReset =
    config.rowDimension === resetConfig.rowDimension &&
    config.columnDimension === resetConfig.columnDimension &&
    config.metric === resetConfig.metric &&
    config.comparison === resetConfig.comparison &&
    config.projection === resetConfig.projection;

  const handleColumnDimension = (value: string) => {
    const next =
      value === "none" ? null : selectedOptionValue(value, COLUMN_DIMENSIONS);
    if (next === undefined) return;
    onConfigChange(
      normalizeExpenseAnalyzeConfig(
        { ...config, columnDimension: next },
        filters,
      ),
    );
  };
  const handleRowDimension = (value: ExpenseAnalyzeRowDimension) => {
    onConfigChange(
      normalizeExpenseAnalyzeConfig(
        { ...config, rowDimension: value },
        filters,
      ),
    );
  };
  const downloadReady = query.data?.status === "ready";
  const handleDownload = () => {
    if (!downloadReady || query.data?.status !== "ready") return;
    operations.browser.downloadCsv({
      filename: expenseAnalyzeCsvFilename(query.data),
      content: expenseAnalyzeCsv(query.data),
    });
  };
  const handleCopyLink = async () => {
    if (await operations.browser.copyText(window.location.href)) {
      toast.success("Analysis link copied");
      return;
    }
    toast.error("Couldn't copy the analysis link");
  };

  return (
    <Stack gap="md">
      <Row align="center" gap="xs" className="flex-wrap">
        <label htmlFor={rowsId} className="text-xs">
          Rows
        </label>
        <NativeSelect
          id={rowsId}
          value={rowDimension}
          onChange={(event) => {
            const next = selectedOptionValue(
              event.target.value,
              ROW_DIMENSIONS,
            );
            if (next) handleRowDimension(next);
          }}
        >
          {ROW_DIMENSIONS.map((dimension) => (
            <option key={dimension.value} value={dimension.value}>
              {dimension.label}
            </option>
          ))}
        </NativeSelect>
        <label htmlFor={columnsId} className="ml-2 text-xs">
          Columns
        </label>
        <NativeSelect
          id={columnsId}
          value={columnDimension ?? "none"}
          onChange={(event) => handleColumnDimension(event.target.value)}
        >
          <option value="none">None</option>
          {COLUMN_DIMENSIONS.map((dimension) => (
            <option
              key={dimension.value}
              value={dimension.value}
              disabled={dimension.value === rowDimension}
            >
              {dimension.label}
            </option>
          ))}
        </NativeSelect>
        {(columnDimension || comparison !== "none") && (
          <>
            <label htmlFor={metricId} className="ml-2 text-xs">
              Metric
            </label>
            <NativeSelect
              id={metricId}
              value={metric}
              onChange={(event) => {
                const next = selectedOptionValue(event.target.value, METRICS);
                if (next) onConfigChange({ ...config, metric: next });
              }}
            >
              {METRICS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </>
        )}
        {columnDimension && comparison !== "none" && (
          <>
            <label htmlFor={projectionId} className="ml-2 text-xs">
              Show
            </label>
            <NativeSelect
              id={projectionId}
              value={projection}
              onChange={(event) => {
                const next = selectedOptionValue(
                  event.target.value,
                  PROJECTIONS,
                );
                if (next) onConfigChange({ ...config, projection: next });
              }}
            >
              {PROJECTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </>
        )}
        <label
          htmlFor={compareId}
          className={cn(
            "ml-2 flex items-center gap-2 text-xs",
            !comparisonAllowed && "text-muted-foreground",
          )}
          title={
            comparisonAllowed
              ? undefined
              : "Comparison needs a bounded date range and cannot use Month as an axis."
          }
        >
          Compare previous period
          <Switch
            id={compareId}
            checked={comparison === "previousPeriod"}
            disabled={!comparisonAllowed}
            onCheckedChange={(checked) =>
              onConfigChange(
                normalizeExpenseAnalyzeConfig(
                  {
                    ...config,
                    comparison: checked ? "previousPeriod" : "none",
                  },
                  filters,
                ),
              )
            }
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={!canSwapExpenseAnalyzeAxes(config)}
          title={
            canSwapExpenseAnalyzeAxes(config)
              ? "Swap rows and columns"
              : "Swap needs two column-compatible dimensions"
          }
          onClick={() =>
            onConfigChange(swapExpenseAnalyzeAxes(config, filters))
          }
        >
          <ArrowsLeftRightIcon />
          Swap
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isReset}
          onClick={() => onConfigChange(resetConfig)}
        >
          <ArrowCounterClockwiseIcon />
          Reset
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopyLink}>
          <ClipboardIcon />
          Copy link
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!downloadReady}
          onClick={handleDownload}
        >
          <DownloadIcon />
          Download CSV
        </Button>
      </Row>

      <ExpenseAnalysisResult
        isLoading={query.isLoading}
        isError={query.isError}
        data={query.data}
        filters={filters}
        metric={metric}
        projection={projection}
        onRetry={() => void query.refetch()}
        onOpenLedger={onOpenLedger}
      />
    </Stack>
  );
}
