import {
  type CostType,
  costTypeValues,
  type ExpenseTradeCostAggregate,
  type Trade,
} from "@cubby/schemas/project";
import { ResponsiveBar } from "@nivo/bar";
import { sum } from "es-toolkit";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { ChartTooltip } from "~/app/projects/charts/ChartTooltip";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { capitalize, TRADE_LABELS } from "~/app/projects/project-formatting";
import { HEAT_CLASSES, heatBucket } from "~/components/matrix/heat-scale";
import {
  bodyRule,
  cellMono,
  EMPTY_MARK,
  emptyCell,
  footRule,
  headRule,
  stickyRowHeaderCard,
  totalCell,
} from "~/components/matrix/matrix-chrome";
import {
  nivoBarChrome,
  nivoChartTheme,
  nivoCurrencyAxis,
} from "~/lib/nivo-theme";
import { getCostTypeColor } from "~/lib/status-colors";
import { cn, formatCurrency } from "~/lib/utils";

const COST_KEYS = costTypeValues;

type PivotRow = {
  trade: Trade;
  cells: Record<CostType, number>;
  total: number;
};

/**
 * Groups `expense.analytics`'s `tradeCostMatrix` rows (already one row per
 * trade×costType, server-aggregated) into the same trade-keyed pivot shape
 * `~/app/projects/charts/trade-cost-pivot.ts` builds from raw expenses —
 * kept as a local, `net`-keyed variant here so the analytics view never needs
 * a raw expense fetch. Negative-net rows are kept (refunds/credits are
 * real); only all-zero trades are dropped.
 */
function buildAggregatePivot(rows: ExpenseTradeCostAggregate[]) {
  const grouped = new Map<Trade, Record<CostType, number>>();
  const emptyCells = (): Record<CostType, number> => ({
    materials: 0,
    tools: 0,
    services: 0,
  });

  for (const row of rows) {
    let entry = grouped.get(row.trade);
    if (!entry) {
      entry = emptyCells();
      grouped.set(row.trade, entry);
    }
    entry[row.costType] += row.net;
  }

  const columnTotals = emptyCells();
  let maxCell = 0;
  const pivotRows: PivotRow[] = Array.from(grouped.entries())
    .map(([trade, cells]) => {
      for (const key of COST_KEYS) {
        columnTotals[key] += cells[key];
        if (cells[key] > maxCell) maxCell = cells[key];
      }
      return { trade, cells, total: sum(Object.values(cells)) };
    })
    .filter((row) => COST_KEYS.some((key) => row.cells[key] !== 0))
    .sort((a, b) => b.total - a.total);

  const grandTotal = sum(Object.values(columnTotals));
  return { rows: pivotRows, columnTotals, grandTotal, maxCell };
}

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
      .map((row) => ({ trade: row.trade, ...row.cells, total: row.total }))
      .reverse();
    return {
      rows: positive,
      hiddenCount: rows.filter((row) => row.total <= 0).length,
    };
  }, [tradeCostMatrix]);

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No expense data." />;
  }

  const chartHeight = Math.max(300, rows.length * 32 + 60);
  const tradeLabel = (value: string) => TRADE_LABELS[value as Trade] ?? value;

  return (
    <div className="flex flex-col gap-1">
      <div style={{ height: chartHeight }}>
        <ResponsiveBar
          data={rows}
          keys={[...COST_KEYS]}
          indexBy="trade"
          layout="horizontal"
          margin={{ top: 10, right: 60, bottom: 40, left: 200 }}
          padding={0.25}
          colors={(bar) => getCostTypeColor(bar.id as string)}
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
      </div>
      {hiddenCount > 0 && (
        <p className="text-muted-foreground text-xs">
          {hiddenCount} trade{hiddenCount === 1 ? "" : "s"} with net ≤ $0 hidden
          (refunds/credits).
        </p>
      )}
    </div>
  );
}

export type AggregateMatrixCell = { trade: Trade; costType: CostType | null };

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

  const isActive = (trade: Trade, costType: CostType | null) =>
    activeCell?.trade === trade && activeCell.costType === costType;

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No expense data." />;
  }

  const interactiveCell =
    "block w-full text-right hover:ring-1 hover:ring-primary/40 hover:ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  const activeCellRing = "ring-2 ring-primary ring-inset";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className={headRule}>
            <th className={cn(stickyRowHeaderCard, "px-2 py-2 font-medium")}>
              Trade
            </th>
            {COST_KEYS.map((key) => (
              <th key={key} className="px-2 py-2 text-right font-medium">
                {capitalize(key)}
              </th>
            ))}
            <th className={cn("px-2 py-2 text-right", totalCell)}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.trade} className={bodyRule}>
              <th
                scope="row"
                className={cn(
                  stickyRowHeaderCard,
                  "px-2 py-2 text-left font-medium text-sm",
                )}
              >
                {TRADE_LABELS[row.trade]}
              </th>
              {COST_KEYS.map((key) => {
                const value = row.cells[key];
                const bucket = heatBucket(value, maxCell);
                const heat = value === 0 ? emptyCell : HEAT_CLASSES[bucket];
                const label =
                  value !== 0 ? formatCurrency(value, 0) : EMPTY_MARK;
                const title =
                  value !== 0 ? formatCurrency(value, 2) : undefined;

                if (!onCellClick) {
                  return (
                    <td key={key} className={cn(cellMono, heat)} title={title}>
                      {label}
                    </td>
                  );
                }
                return (
                  <td key={key} className="p-0">
                    <button
                      type="button"
                      onClick={() => onCellClick(row.trade, key)}
                      title={title}
                      className={cn(
                        cellMono,
                        heat,
                        interactiveCell,
                        isActive(row.trade, key) && activeCellRing,
                      )}
                    >
                      {label}
                    </button>
                  </td>
                );
              })}
              {onCellClick ? (
                <td className="p-0">
                  <button
                    type="button"
                    onClick={() => onCellClick(row.trade, null)}
                    className={cn(
                      cellMono,
                      totalCell,
                      interactiveCell,
                      isActive(row.trade, null) && activeCellRing,
                    )}
                  >
                    {formatCurrency(row.total, 0)}
                  </button>
                </td>
              ) : (
                <td className={cn(cellMono, totalCell)}>
                  {formatCurrency(row.total, 0)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={footRule}>
            <th
              className={cn(
                stickyRowHeaderCard,
                "px-2 py-2 text-left font-medium",
              )}
            >
              Total
            </th>
            {COST_KEYS.map((key) => (
              <td
                key={key}
                className={cn(cellMono, "font-semibold text-primary")}
              >
                {formatCurrency(columnTotals[key], 0)}
              </td>
            ))}
            <td className={cn(cellMono, "font-semibold text-primary")}>
              {formatCurrency(grandTotal, 0)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
