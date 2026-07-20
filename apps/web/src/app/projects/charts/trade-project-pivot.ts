import type { ProjectOut, PurchaseOut } from "@cubby/schemas/project";
import { sumBy } from "es-toolkit";

/** Bucket for purchases with no project (or a project that isn't loaded). */
export const NO_PROJECT_KEY = "_none";
/** Rollup column for every root outside the top `MAX_PROJECT_COLUMNS`. */
export const OTHER_PROJECTS_KEY = "_other";

const MAX_PROJECT_COLUMNS = 8;

// Mirrors MAX_PROJECT_TREE_DEPTH in server/repo/project/subtree.ts — the tree
// is cycle-guarded on write, so this is a belt-and-braces stop, not a real bound.
const MAX_DEPTH = 100;

type TradeProjectColumn = {
  key: string; // project id, NO_PROJECT_KEY, or OTHER_PROJECTS_KEY
  label: string;
  total: number;
};

type TradeProjectRow = {
  trade: string;
  cells: Record<string, number>; // keyed by column key
  total: number;
};

export type TradeProjectPivot = {
  rows: TradeProjectRow[]; // sorted total DESC, all-zero rows dropped
  columns: TradeProjectColumn[]; // sorted by magnitude, rollup column last
  grandTotal: number;
  maxCell: number; // for heatmap scaling
};

/**
 * Walks `parentProjectId` to the top-most project we actually have. A project
 * whose parent was filtered out of the dashboard set becomes its own root —
 * folding into an absent column would silently drop its spend.
 */
function resolveRoot(
  projectId: string,
  parentById: Map<string, string | null>,
): string {
  let current = projectId;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent)) return current;
    current = parent;
  }
  return current;
}

/**
 * Trade × root-project pivot of **committed** spend (future-flagged and
 * cost-less purchases excluded), with sub-project spend folded into its
 * top-level root.
 */
export function buildTradeProjectPivot(
  projects: ProjectOut[],
  purchases: PurchaseOut[],
): TradeProjectPivot {
  const parentById = new Map<string, string | null>(
    projects.map((p) => [p.id, p.parentProjectId]),
  );
  const nameById = new Map<string, string>(projects.map((p) => [p.id, p.name]));

  // trade -> root key -> dollars
  const byTrade = new Map<string, Map<string, number>>();
  const rootTotals = new Map<string, number>();

  for (const purchase of purchases) {
    if (purchase.future || purchase.cost == null) continue;

    const rootKey =
      purchase.projectId && parentById.has(purchase.projectId)
        ? resolveRoot(purchase.projectId, parentById)
        : NO_PROJECT_KEY;

    let cells = byTrade.get(purchase.trade);
    if (!cells) {
      cells = new Map();
      byTrade.set(purchase.trade, cells);
    }
    cells.set(rootKey, (cells.get(rootKey) ?? 0) + purchase.cost);
    rootTotals.set(rootKey, (rootTotals.get(rootKey) ?? 0) + purchase.cost);
  }

  // Rank by magnitude, not signed total: a big net-negative column (the
  // wedding's family contributions) is just as worth showing as a big positive.
  // Every root that saw a purchase gets ranked (even a net-zero one) — dropping
  // it here would strand its cells in a rollup column that may not exist.
  const ranked = Array.from(rootTotals.entries()).sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  );

  const shown = ranked.slice(0, MAX_PROJECT_COLUMNS);
  const rolled = ranked.slice(MAX_PROJECT_COLUMNS);

  const columns: TradeProjectColumn[] = shown.map(([key, total]) => ({
    key,
    label:
      key === NO_PROJECT_KEY ? "No project" : (nameById.get(key) ?? "Unknown"),
    total,
  }));
  if (rolled.length > 0) {
    columns.push({
      key: OTHER_PROJECTS_KEY,
      label: `Other projects (${rolled.length})`,
      total: sumBy(rolled, ([, total]) => total),
    });
  }

  const shownKeys = new Set(shown.map(([key]) => key));
  let maxCell = 0;

  const rows: TradeProjectRow[] = Array.from(byTrade.entries())
    .map(([trade, sums]) => {
      const cells: Record<string, number> = {};
      let total = 0;
      for (const [rootKey, value] of sums) {
        const columnKey = shownKeys.has(rootKey) ? rootKey : OTHER_PROJECTS_KEY;
        cells[columnKey] = (cells[columnKey] ?? 0) + value;
        total += value;
      }
      for (const value of Object.values(cells)) {
        if (value > maxCell) maxCell = value;
      }
      return { trade, cells, total };
    })
    // Keep negative-net rows (refunds/credits) so the totals reconcile with the
    // visible rows; only trades with no committed spend at all are dropped.
    .filter((row) => Object.values(row.cells).some((value) => value !== 0))
    .sort((a, b) => b.total - a.total);

  const grandTotal = sumBy(columns, (column) => column.total);

  return { rows, columns, grandTotal, maxCell };
}
