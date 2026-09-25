import {
  type CostType,
  costTypeValues,
  type Trade,
} from "@cubby/schemas/project";
import { sum } from "es-toolkit";

// Derived from the zod enum — not re-listed.
export const PIVOT_COST_KEYS = costTypeValues;
export type PivotCostKey = CostType;

type TradePivotRow = {
  trade: Trade | null;
  cells: Record<PivotCostKey, number>; // dollar sums
  total: number;
};

export type TradeCostPivot = {
  rows: TradePivotRow[]; // sorted total DESC, all-zero rows dropped
  columnTotals: Record<PivotCostKey, number>;
  grandTotal: number;
  maxCell: number; // for heatmap scaling
};

const emptyCells = () =>
  ({
    materials: 0,
    tools: 0,
    services: 0,
  }) satisfies Record<PivotCostKey, number>;

/** One server-aggregated trade×costType amount from `expense.analytics`. */
export type TradeCostContribution = {
  trade: Trade | null;
  costType: PivotCostKey;
  value: number;
};

export function pivotTradeCostContributions(
  contributions: Iterable<TradeCostContribution>,
): TradeCostPivot {
  const grouped = new Map<Trade | null, Record<PivotCostKey, number>>();

  for (const { trade, costType, value } of contributions) {
    let entry = grouped.get(trade);
    if (!entry) {
      entry = emptyCells();
      grouped.set(trade, entry);
    }
    entry[costType] += value;
  }

  const columnTotals = emptyCells();
  let maxCell = 0;

  const rows: TradePivotRow[] = Array.from(grouped.entries())
    .map(([trade, cells]) => {
      for (const key of PIVOT_COST_KEYS) {
        columnTotals[key] += cells[key];
        if (cells[key] > maxCell) maxCell = cells[key];
      }
      return { trade, cells, total: sum(Object.values(cells)) };
    })
    // Keep negative-net rows (refunds/credits, e.g. family wedding
    // contributions) — dropping them would make columnTotals disagree with
    // the visible rows. Only trades with no spend at all are dropped.
    .filter((row) => PIVOT_COST_KEYS.some((key) => row.cells[key] !== 0))
    .sort((a, b) => b.total - a.total);

  const grandTotal = sum(Object.values(columnTotals));

  return { rows, columnTotals, grandTotal, maxCell };
}
