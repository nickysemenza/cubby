import type { PurchaseOut, Trade } from "@cubby/schemas/project";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { cn, formatCurrency } from "~/lib/utils";
import { capitalize, TRADE_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";
import { cellMono, HEAT_CLASSES, heatBucket } from "./heat-scale";
import {
  buildTradeCostPivot,
  PIVOT_COST_KEYS,
  type PivotCostKey,
} from "./trade-cost-pivot";

const interactiveCell =
  "block w-full text-right hover:ring-1 hover:ring-primary/40 hover:ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const activeCellRing = "ring-2 ring-primary ring-inset";

export type TradeCostCell = { trade: Trade; costType: PivotCostKey | null };

export function TradeCostMatrix({
  purchases,
  onCellClick,
  activeCell,
}: {
  purchases: PurchaseOut[];
  /** `costType: null` is a row-total click (filter by trade alone). */
  onCellClick?: (trade: Trade, costType: PivotCostKey | null) => void;
  activeCell?: TradeCostCell | null;
}) {
  const { rows, columnTotals, grandTotal, maxCell } = useMemo(
    () => buildTradeCostPivot(purchases),
    [purchases],
  );

  const isActive = (trade: Trade, costType: PivotCostKey | null) =>
    activeCell?.trade === trade && activeCell.costType === costType;

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No purchase data." />;
  }

  const columns: PivotCostKey[] = PIVOT_COST_KEYS.filter(
    (key) => key !== "other" || columnTotals.other > 0,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="eyebrow border-primary border-b-2">
            <th className="sticky left-0 z-10 bg-card px-2 py-2 font-medium">
              Trade
            </th>
            {columns.map((key) => (
              <th key={key} className="px-2 py-2 text-right font-medium">
                {capitalize(key)}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium text-primary">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.trade}
              className="border-border border-b border-dashed"
            >
              <th
                scope="row"
                className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium text-sm"
              >
                {TRADE_LABELS[row.trade]}
              </th>
              {columns.map((key) => {
                const value = row.cells[key];
                const bucket = heatBucket(value, maxCell);
                const heat =
                  value === 0
                    ? "text-muted-foreground/30"
                    : HEAT_CLASSES[bucket];
                const label = value !== 0 ? formatCurrency(value, 0) : "·";
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
                      "font-medium text-primary",
                      interactiveCell,
                      isActive(row.trade, null) && activeCellRing,
                    )}
                  >
                    {formatCurrency(row.total, 0)}
                  </button>
                </td>
              ) : (
                <td className={cn(cellMono, "font-medium text-primary")}>
                  {formatCurrency(row.total, 0)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="eyebrow border-primary border-t-2">
            <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">
              Total
            </th>
            {columns.map((key) => (
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
