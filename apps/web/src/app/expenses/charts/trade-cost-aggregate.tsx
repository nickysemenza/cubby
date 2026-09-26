import {
  type CostType,
  costTypeValues,
  type ExpenseTradeCostAggregate,
  type Trade,
} from "@cubby/schemas/project";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { useMemo } from "react";

import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { HorizontalBarChart } from "~/app/projects/charts/horizontal-bar-chart";
import { capitalize, TRADE_LABELS } from "~/app/projects/project-formatting";
import { CrossTabTable } from "~/components/matrix/cross-tab-table";
import type { CrossTabColumn } from "~/components/matrix/group-columns";
import { HEAT_CLASSES, heatBucket } from "~/components/matrix/heat-scale";
import {
  cellMono,
  EMPTY_MARK,
  emptyCell,
  totalCell,
} from "~/components/matrix/matrix-chrome";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { getCostTypeColor } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";

import { pivotTradeCostContributions } from "./trade-cost-pivot";

const COST_KEYS = costTypeValues;
const costTypeForKey = (value: string): CostType | undefined =>
  COST_KEYS.find((key) => key === value);
const tradeForKey = (value: string): Trade | undefined =>
  Object.keys(TRADE_LABELS).find((key): key is Trade => key === value);
const UNASSIGNED_TRADE_KEY = "__unassigned__";
const tradeLabel = (trade: Trade | null) =>
  trade === null ? "Unassigned trade" : TRADE_LABELS[trade];

/** Column key is the cost type itself, so cells index `row.cells` directly. */
const COLUMNS: CrossTabColumn<CostType>[] = COST_KEYS.map((key) => ({
  key,
  data: key,
}));

const PINNED = [{ key: "total", label: "Total", className: totalCell }];

/**
 * `expense.analytics`'s `tradeCostMatrix` is already one row per trade×costType
 * (server-aggregated), so it only needs normalizing to the shared contribution
 * shape — the pivot itself, including keeping negative-net rows (refunds and
 * credits are real) while dropping all-zero trades, lives in trade-cost-pivot.
 */
const buildAggregatePivot = (rows: ExpenseTradeCostAggregate[]) =>
  pivotTradeCostContributions(
    rows.map((row) => ({
      trade: row.trade,
      costType: row.costType,
      value: row.net,
    })),
  );

/** Stacked horizontal bars — trade × cost type, positive-net trades only
 * (stacked bars can't render a negative segment; the matrix below keeps them). */
export function TradeBarsAggregate({
  tradeCostMatrix,
}: {
  tradeCostMatrix: ExpenseTradeCostAggregate[];
}) {
  const { rows, hiddenCount } = useMemo(() => {
    const { rows } = buildAggregatePivot(tradeCostMatrix);
    const positive = rows
      .filter((row) => row.total > 0)
      .map((row) => ({
        trade: row.trade ?? UNASSIGNED_TRADE_KEY,
        ...row.cells,
        total: row.total,
      }))
      .reverse();
    return {
      rows: positive,
      hiddenCount: rows.filter((row) => row.total <= 0).length,
    };
  }, [tradeCostMatrix]);

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBagIcon} title="No expense data." />;
  }

  const tradeLabel = (value: string) => {
    if (value === UNASSIGNED_TRADE_KEY) return "Unassigned trade";
    const trade = tradeForKey(value);
    return trade ? TRADE_LABELS[trade] : value;
  };

  return (
    <div className="flex flex-col gap-1">
      <HorizontalBarChart
        data={rows}
        minHeight={300}
        keys={[...COST_KEYS]}
        indexBy="trade"
        margin={{ top: 10, right: 60, bottom: 40, left: 200 }}
        padding={0.25}
        colors={(bar) => {
          const costType = costTypeForKey(String(bar.id));
          return costType ? getCostTypeColor(costType) : "var(--slate)";
        }}
        {...nivoBarChrome}
        axisBottom={nivoCurrencyAxis}
        axisLeft={{ tickSize: 0, tickPadding: 8, format: tradeLabel }}
        label={(d) =>
          d.value && d.value > 0 ? formatCurrency(d.value, 0) : ""
        }
        labelSkipWidth={40}
        labelTextColor="var(--background)"
        enableGridX
        enableGridY={false}
        tooltip={({ id, value, indexValue, color }) => (
          <ChartTooltip>
            <strong>{tradeLabel(String(indexValue))}</strong> — {id}:{" "}
            <span style={{ color }}>{formatCurrency(value, 0)}</span>
          </ChartTooltip>
        )}
        legends={[
          {
            dataFrom: "keys",
            anchor: "bottom",
            direction: "row",
            translateY: 40,
            itemWidth: 100,
            itemHeight: 20,
            symbolSize: 12,
            symbolShape: "circle",
            itemTextColor: "var(--muted-foreground)",
          },
        ]}
        theme={nivoChartTheme}
      />
      {hiddenCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {hiddenCount} trade{hiddenCount === 1 ? "" : "s"} with net ≤ $0 hidden
          (refunds/credits).
        </p>
      )}
    </div>
  );
}

export type AggregateMatrixCell = {
  trade: Trade | null;
  costType: CostType | null;
};

/** Trade × Cost Type heat-scale table, from the same aggregate pivot — the
 * analytics-view replacement for `TradeCostMatrix` (per-cell hover previews
 * are dropped since aggregates carry no per-expense rows; the click-to-filter
 * affordance is kept). */
export function TradeCostMatrixAggregate({
  tradeCostMatrix,
  onCellClick,
  activeCell,
}: {
  tradeCostMatrix: ExpenseTradeCostAggregate[];
  onCellClick?: (trade: Trade, costType: CostType | null) => void;
  activeCell?: AggregateMatrixCell | null;
}) {
  const { rows, columnTotals, grandTotal, maxCell } = useMemo(
    () => buildAggregatePivot(tradeCostMatrix),
    [tradeCostMatrix],
  );

  const isActive = (trade: Trade | null, costType: CostType | null) =>
    activeCell?.trade === trade && activeCell.costType === costType;

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBagIcon} title="No expense data." />;
  }

  const interactiveCell =
    "block w-full text-right hover:ring-1 hover:ring-primary/40 hover:ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  const activeCellRing = "ring-2 ring-primary ring-inset";

  return (
    <CrossTabTable
      cornerLabel="Trade"
      columns={COLUMNS}
      rows={rows.map((row) => ({
        key: row.trade ?? UNASSIGNED_TRADE_KEY,
        data: row,
      }))}
      pinned={PINNED}
      bareCells={Boolean(onCellClick)}
      footer={[
        {
          key: "total",
          label: "Total",
          cellClassName: "font-semibold text-primary",
          cell: (key) => {
            const costType = costTypeForKey(key);
            return formatCurrency(costType ? columnTotals[costType] : 0, 0);
          },
          pinnedCell: () => formatCurrency(grandTotal, 0),
        },
      ]}
      renderColumnHeader={({ key }) => capitalize(key)}
      renderRowHeader={({ data: row }) => tradeLabel(row.trade)}
      cellTitle={({ data: row }, { key }) => {
        const costType = costTypeForKey(key);
        const value = costType ? row.cells[costType] : 0;
        return value !== 0 ? formatCurrency(value, 2) : undefined;
      }}
      cellClassName={({ data: row }, { key }) => {
        const costType = costTypeForKey(key);
        const value = costType ? row.cells[costType] : 0;
        return value === 0
          ? emptyCell
          : HEAT_CLASSES[heatBucket(value, maxCell)];
      }}
      renderCell={({ data: row }, { key }) => {
        const trade = row.trade;
        const costType = costTypeForKey(key);
        const value = costType ? row.cells[costType] : 0;
        const label = value !== 0 ? formatCurrency(value, 0) : EMPTY_MARK;
        if (!onCellClick || trade === null) return label;
        const heat =
          value === 0 ? emptyCell : HEAT_CLASSES[heatBucket(value, maxCell)];
        return (
          <button
            type="button"
            onClick={() => {
              onCellClick(trade, costType ?? null);
            }}
            title={value !== 0 ? formatCurrency(value, 2) : undefined}
            className={cn(
              cellMono,
              heat,
              interactiveCell,
              isActive(trade, costType ?? null) && activeCellRing,
            )}
          >
            {label}
          </button>
        );
      }}
      renderPinnedCell={({ data: row }) => {
        const trade = row.trade;
        return onCellClick && trade !== null ? (
          <button
            type="button"
            onClick={() => onCellClick(trade, null)}
            className={cn(
              cellMono,
              totalCell,
              interactiveCell,
              isActive(trade, null) && activeCellRing,
            )}
          >
            {formatCurrency(row.total, 0)}
          </button>
        ) : (
          formatCurrency(row.total, 0)
        );
      }}
    />
  );
}
