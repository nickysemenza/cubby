import type { PurchaseOut, Trade } from "@cubby/schemas/project";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { cn, formatCurrency } from "~/lib/utils";
import { capitalize, TRADE_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";
import {
  buildTradeCostPivot,
  PIVOT_COST_KEYS,
  type PivotCostKey,
} from "./trade-cost-pivot";

const cellMono = "px-2 py-2 text-right font-mono text-xs tabular-nums";

const tradeLabel = (value: string): string =>
  TRADE_LABELS[value as Trade] ?? value;

// Dollar sums are heavy-tailed, so bucket on a sqrt-scaled ratio against the
// grid-wide max (one shared scale, like Sheets' color-scale).
function heatBucket(value: number, max: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value <= 0 || max <= 0) return 0;
  const t = Math.sqrt(value / max);
  if (t >= 0.85) return 5;
  if (t >= 0.6) return 4;
  if (t >= 0.35) return 3;
  if (t >= 0.15) return 2;
  return 1;
}

const HEAT_CLASSES: Record<0 | 1 | 2 | 3 | 4 | 5, string> = {
  0: "",
  1: "bg-chart-seq-1",
  2: "bg-chart-seq-2",
  3: "bg-chart-seq-3",
  4: "bg-chart-seq-4 text-background", // deep fills flip to paper ink
  5: "bg-chart-seq-5 text-background",
};

export function TradeCostMatrix({ purchases }: { purchases: PurchaseOut[] }) {
  const { rows, columnTotals, grandTotal, maxCell } = useMemo(
    () => buildTradeCostPivot(purchases),
    [purchases],
  );

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
                {tradeLabel(row.trade)}
              </th>
              {columns.map((key) => {
                const value = row.cells[key];
                const bucket = heatBucket(value, maxCell);
                return (
                  <td
                    key={key}
                    className={cn(
                      cellMono,
                      value === 0
                        ? "text-muted-foreground/30"
                        : HEAT_CLASSES[bucket],
                    )}
                    title={value !== 0 ? formatCurrency(value, 2) : undefined}
                  >
                    {value !== 0 ? formatCurrency(value, 0) : "·"}
                  </td>
                );
              })}
              <td className={cn(cellMono, "font-medium text-primary")}>
                {formatCurrency(row.total, 0)}
              </td>
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
