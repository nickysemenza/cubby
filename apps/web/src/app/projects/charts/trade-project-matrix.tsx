import type { ProjectOut, PurchaseOut, Trade } from "@cubby/schemas/project";
import { ShoppingBag } from "lucide-react";
import { useMemo } from "react";
import { cn, formatCurrency } from "~/lib/utils";
import { TRADE_LABELS } from "../shared";
import { ChartEmpty } from "./chart-empty";
import { cellMono, HEAT_CLASSES, heatBucket } from "./heat-scale";
import { buildTradeProjectPivot } from "./trade-project-pivot";

const tradeLabel = (value: string): string =>
  TRADE_LABELS[value as Trade] ?? value;

/**
 * Trade × project cross-tab: what each trade actually costs, per top-level
 * project, with sub-project spend folded into its root. Cross-tab layout
 * (sticky row header, per-cell heat) so it's a raw `<table>`, not `<RTable>`.
 */
export function TradeProjectMatrix({
  projects,
  purchases,
}: {
  projects: ProjectOut[];
  purchases: PurchaseOut[];
}) {
  const { rows, columns, grandTotal, maxCell } = useMemo(
    () => buildTradeProjectPivot(projects, purchases),
    [projects, purchases],
  );

  if (rows.length === 0) {
    return <ChartEmpty icon={ShoppingBag} title="No committed spend." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="eyebrow border-primary border-b-2">
            <th className="sticky left-0 z-10 bg-card px-2 py-2 font-medium">
              Trade
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                className="max-w-[10rem] truncate px-2 py-2 text-right font-medium"
                title={column.label}
              >
                {column.label}
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
              {columns.map((column) => {
                const value = row.cells[column.key] ?? 0;
                return (
                  <td
                    key={column.key}
                    className={cn(
                      cellMono,
                      value === 0
                        ? "text-muted-foreground/30"
                        : HEAT_CLASSES[heatBucket(value, maxCell)],
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
            {columns.map((column) => (
              <td
                key={column.key}
                className={cn(cellMono, "font-semibold text-primary")}
              >
                {formatCurrency(column.total, 0)}
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
