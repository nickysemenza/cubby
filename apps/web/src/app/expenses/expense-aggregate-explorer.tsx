import type {
  ExpenseAnalyzeAggregate,
  ExpenseAnalyzeColumnDimension,
  ExpenseAnalyzeComparison,
  ExpenseAnalyzeReadyOut,
  ExpenseAnalyzeRowDimension,
  ExpenseFilters,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useId, useMemo, useState } from "react";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { Row, Stack } from "~/components/layout";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { useTRPC } from "~/integrations/trpc/react";
import { cn, formatCount, formatCurrency } from "~/lib/utils";

type Metric = keyof ExpenseAnalyzeAggregate;
type ComparisonProjection = "current" | "previous" | "delta" | "percent";

const METRICS: readonly { value: Metric; label: string }[] = [
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

const EMPTY_AGGREGATE: ExpenseAnalyzeAggregate = {
  actual: 0,
  committed: 0,
  credits: 0,
  net: 0,
  count: 0,
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
  projection: ComparisonProjection,
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
  projection: ComparisonProjection,
) {
  if (projection === "current") return current;
  if (projection === "previous") return previous;
  if (previous === null) return null;
  if (projection === "delta") return current - previous;
  if (previous === 0) return current === 0 ? null : Number.POSITIVE_INFINITY;
  return (current - previous) / Math.abs(previous);
}

function formatMetric(value: number | null, metric: Metric) {
  if (value === null) return "—";
  return metric === "count" ? formatCount(value) : formatCurrency(value);
}

export function formatExpenseAnalyzeValue(
  current: number,
  previous: number | null,
  metric: Metric,
  projection: ComparisonProjection,
) {
  const value = valueForProjection(current, previous, projection);
  if (projection !== "percent") return formatMetric(value, metric);
  if (value === null) return "—";
  if (value === Number.POSITIVE_INFINITY) return "New";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(value);
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
  if (data.columnDimension) return "Not represented in this grid";
  if (data.rowDimension === "project") return "Unattributed to a project";
  if (data.rowDimension === "vendor") return "Unattributed to a vendor";
  if (data.rowDimension === "month") return "Undated spend";
  return "Purchase adjustments";
}

function ReconciliationNote({
  data,
  metric,
}: {
  data: ExpenseAnalyzeReadyOut;
  metric: Metric;
}) {
  const causeEntries: [
    string,
    ExpenseAnalyzeReadyOut["reconciliation"]["causes"]["adjustments"],
  ][] = [
    ["Adjustments", data.reconciliation.causes.adjustments],
    ["Unattributed project", data.reconciliation.causes.unattributedProject],
    ["Unattributed vendor", data.reconciliation.causes.unattributedVendor],
    ["Undated", data.reconciliation.causes.undated],
  ];
  const causes = causeEntries.filter(
    ([, value]) =>
      value.current[metric] !== 0 || (value.previous?.[metric] ?? 0) !== 0,
  );
  const current = (value: { current: ExpenseAnalyzeAggregate }) =>
    formatMetric(value.current[metric], metric);

  return (
    <Stack gap="xs" className="text-muted-foreground text-xs">
      <p>
        Scope total {current(data.totals.scope)} · grid total{" "}
        {current(data.totals.grid)} · {tailLabel(data).toLowerCase()}{" "}
        {current(data.reconciliation.tail)}.
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
  comparison,
  metric,
  onOpenLedger,
}: {
  data: ExpenseAnalyzeReadyOut;
  comparison: ExpenseAnalyzeComparison;
  metric: Metric;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(() =>
    initialExpenseAnalyzeSorting(comparison),
  );
  const rows = useMemo(() => buildExpenseAnalyzeTableRows(data), [data]);
  const columns = useMemo(() => {
    const numericMeta = { numeric: true, mono: true } as const;
    const tail = data.reconciliation.tail;
    const regularColumns: CubbyColumnDef<ExpenseAnalyzeTableRow>[] =
      METRICS.map(({ value: accessor, label }) =>
        helper.accessor((row) => row.current[accessor], {
          id: accessor,
          header: label,
          size: accessor === "count" ? 88 : 128,
          minSize: accessor === "count" ? 72 : 104,
          meta: numericMeta,
          cell: (info) => formatMetric(info.getValue(), accessor),
          footer: () => formatMetric(tail.current[accessor], accessor),
          enableCellSelection: false,
        }),
      );
    const compareColumn = (
      id: string,
      header: string,
      projection: ComparisonProjection,
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
          cell: (info) =>
            projection === "percent"
              ? formatExpenseAnalyzeValue(
                  info.row.original.current[metric],
                  info.row.original.previous?.[metric] ?? null,
                  metric,
                  projection,
                )
              : formatMetric(info.getValue(), metric),
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
    return [
      helper.accessor("label", {
        header: "Label",
        size: 260,
        minSize: 160,
        footer: () => tailLabel(data),
        enableCellSelection: false,
      }),
      ...(comparison === "none"
        ? regularColumns
        : [
            compareColumn("current", "Current", "current"),
            compareColumn("previous", "Previous", "previous"),
            compareColumn("delta", "Delta", "delta"),
            compareColumn("percent", "Delta %", "percent"),
          ]),
      helper.display({
        id: "actions",
        header: "",
        size: 88,
        minSize: 88,
        enableHiding: false,
        enableCellSelection: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Open current-period Ledger rows for ${row.original.label}`}
            onClick={() => onOpenLedger(row.original.filter)}
          >
            Ledger
          </Button>
        ),
      }),
    ] as CubbyColumnDef<ExpenseAnalyzeTableRow>[];
  }, [comparison, data, metric, onOpenLedger]);
  const layout = useCubbyTableLayout({ key: "expense:analyze", columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: setSorting,
    enableCellSelection: false,
    initialState: { pagination: { pageIndex: 0, pageSize: 500 } },
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
        metric={comparison === "none" ? "net" : metric}
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
  return cells.reduce(
    (result, cell) => ({
      current: addAggregate(result.current, cell.current),
      previous: cell.previous
        ? addAggregate(result.previous ?? EMPTY_AGGREGATE, cell.previous)
        : result.previous,
    }),
    {
      current: EMPTY_AGGREGATE,
      previous: null as ExpenseAnalyzeAggregate | null,
    },
  );
}

function ExpenseAnalyzeCrossTab({
  data,
  metric,
  projection,
  onOpenLedger,
}: {
  data: ExpenseAnalyzeReadyOut;
  metric: Metric;
  projection: ComparisonProjection;
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
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          return total ? display(total.current, total.previous) : "—";
        }}
        footer={[
          {
            key: "grid-total",
            label: "Grid total",
            emphasis: "rule",
            cell: (columnKey) => {
              const total = aggregateCells(
                data.cells.filter((cell) => cell.columnKey === columnKey),
              );
              return display(total.current, total.previous);
            },
            pinnedCell: () =>
              display(data.totals.grid.current, data.totals.grid.previous),
          },
        ]}
      />
      <ReconciliationNote data={data} metric={metric} />
      <p className="text-muted-foreground text-xs">
        {projection === "delta" || projection === "percent"
          ? "Delta views combine two periods. Show Current or Previous to open exact Ledger rows."
          : `Click a populated cell to open its exact ${projection === "previous" ? "previous-period" : "current-period"} Ledger rows.`}
      </p>
    </Stack>
  );
}

export function ExpenseAggregateExplorer({
  filters,
  onOpenLedger,
}: {
  filters: ExpenseFilters;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const api = useTRPC();
  const [rowDimension, setRowDimension] =
    useState<ExpenseAnalyzeRowDimension>("trade");
  const [columnDimension, setColumnDimension] =
    useState<ExpenseAnalyzeColumnDimension | null>(null);
  const [comparison, setComparison] =
    useState<ExpenseAnalyzeComparison>("none");
  const [metric, setMetric] = useState<Metric>("net");
  const [projection, setProjection] = useState<ComparisonProjection>("current");
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
  const effectiveComparison = comparisonAllowed ? comparison : "none";
  const query = useQuery({
    ...api.expense.analyze.queryOptions({
      filters,
      rowDimension,
      columnDimension,
      comparison: effectiveComparison,
    }),
    staleTime: 60 * 1000,
  });

  const handleColumnDimension = (value: string) => {
    const next =
      value === "none" ? null : (value as ExpenseAnalyzeColumnDimension);
    setColumnDimension(next === rowDimension ? null : next);
  };
  const handleRowDimension = (value: ExpenseAnalyzeRowDimension) => {
    setRowDimension(value);
    if (columnDimension === value) setColumnDimension(null);
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
          onChange={(event) =>
            handleRowDimension(event.target.value as ExpenseAnalyzeRowDimension)
          }
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
        {(columnDimension || effectiveComparison !== "none") && (
          <>
            <label htmlFor={metricId} className="ml-2 text-xs">
              Metric
            </label>
            <NativeSelect
              id={metricId}
              value={metric}
              onChange={(event) => setMetric(event.target.value as Metric)}
            >
              {METRICS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </NativeSelect>
          </>
        )}
        {columnDimension && effectiveComparison !== "none" && (
          <>
            <label htmlFor={projectionId} className="ml-2 text-xs">
              Show
            </label>
            <NativeSelect
              id={projectionId}
              value={projection}
              onChange={(event) =>
                setProjection(event.target.value as ComparisonProjection)
              }
            >
              <option value="current">Current</option>
              <option value="previous">Previous</option>
              <option value="delta">Delta</option>
              <option value="percent">Delta %</option>
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
            checked={effectiveComparison === "previousPeriod"}
            disabled={!comparisonAllowed}
            onCheckedChange={(checked) =>
              setComparison(checked ? "previousPeriod" : "none")
            }
          />
        </label>
      </Row>

      {!comparisonAllowed && comparison === "previousPeriod" && (
        <p className="text-muted-foreground text-xs">
          Comparison needs both start and end dates and cannot use Month as an
          axis.
        </p>
      )}

      {query.isLoading ? (
        <div
          className="h-52 animate-pulse bg-muted"
          role="status"
          aria-label="Loading analysis"
        />
      ) : query.isError ? (
        <Row
          align="center"
          gap="sm"
          className="border border-destructive/30 p-4 text-sm"
        >
          Couldn&apos;t load this analysis.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </Row>
      ) : query.data?.status === "too_large" ? (
        <div className="border border-border p-4 text-sm">
          This analysis has at least {formatCount(query.data.observedAtLeast)}{" "}
          buckets, beyond its {formatCount(query.data.limit)} bucket limit.
          Narrow the Ledger filters and try again.
        </div>
      ) : query.data && query.data.rows.length === 0 ? (
        <div className="border border-border p-4 text-sm">
          No aggregate buckets match the current Ledger filters.
        </div>
      ) : query.data ? (
        query.data.columnDimension ? (
          <ExpenseAnalyzeCrossTab
            data={query.data}
            metric={metric}
            projection={
              query.data.comparison.mode === "previousPeriod"
                ? projection
                : "current"
            }
            onOpenLedger={onOpenLedger}
          />
        ) : (
          <ExpenseAnalyzeOneDimension
            key={query.data.comparison.mode}
            data={query.data}
            comparison={query.data.comparison.mode}
            metric={metric}
            onOpenLedger={onOpenLedger}
          />
        )
      ) : null}
    </Stack>
  );
}
