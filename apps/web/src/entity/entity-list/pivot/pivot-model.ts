import type {
  ListGroupMargin,
  ListGroupSummary,
} from "@cubby/schemas/pagination";

import { FILTER_NONE } from "~/entity/filters";

export const PIVOT_SHARES = ["count", "row", "column", "total"] as const;
export type PivotShare = (typeof PIVOT_SHARES)[number];

/** Columns beyond this fold into Other while the column field is single-valued. */
const PIVOT_VISIBLE_COLUMNS = 12;

export const OTHER_COLUMN = "__other__";
export const TOTAL_COLUMN = "__total__";

export interface PivotAxisValue {
  key: string;
  label: string;
  total: number;
}

export interface PivotRow extends PivotAxisValue {
  /** The group path a cell in this row extends with its column key. */
  path: readonly string[];
  /** Sub-row values (the third dimension), in their own total order. */
  children: PivotRow[];
  cells: ReadonlyMap<string, number>;
}

export interface PivotSort {
  column: string;
  desc: boolean;
}

export interface PivotModel {
  rows: PivotRow[];
  columns: PivotAxisValue[];
  /** Columns folded into Other; empty when every column is visible. */
  hidden: PivotAxisValue[];
  /** Other is offered only when no record holds several column values. */
  canFoldColumns: boolean;
  grandTotal: number;
  /** Some dimension places a record under more than one value. */
  overlapping: boolean;
}

const byTotal = (left: PivotAxisValue, right: PivotAxisValue) =>
  // No value always sorts last, then larger totals first, then label.
  Number(left.key === FILTER_NONE) - Number(right.key === FILTER_NONE) ||
  right.total - left.total ||
  left.label.localeCompare(right.label);

const marginKey = (dimensions: readonly number[], path: readonly string[]) =>
  JSON.stringify([dimensions, path]);

/**
 * Turn full-population group summaries into a cross-tab: dimension 1 rows,
 * dimension 2 columns, dimension 3 sub-rows. Cells are prefix summaries; row
 * totals are depth-1 summaries; column and sub-row totals are server margins,
 * so a record holding several values still counts once per total.
 */
export function buildPivot(input: {
  groups: readonly ListGroupSummary[];
  margins: readonly ListGroupMargin[];
  totalCount: number | undefined;
  expandColumns: boolean;
  sort: PivotSort | null;
}): PivotModel {
  const margins = new Map(
    input.margins.map((margin) => [
      marginKey(margin.dimensions, margin.path),
      margin.count,
    ]),
  );
  const columnLabels = new Map<string, string>();
  const cellsByPath = new Map<string, Map<string, number>>();
  const rowSummaries: ListGroupSummary[] = [];
  const subSummaries = new Map<string, Map<string, string>>();
  for (const group of input.groups) {
    const [row, column, sub] = group.path;
    if (row === undefined) continue;
    if (group.path.length === 1) {
      rowSummaries.push(group);
      continue;
    }
    if (column === undefined) continue;
    if (group.path.length === 2) columnLabels.set(column, group.label);
    const owner =
      group.path.length === 2
        ? JSON.stringify([row])
        : JSON.stringify([row, sub]);
    if (group.path.length === 3 && sub !== undefined) {
      const subs = subSummaries.get(row) ?? new Map<string, string>();
      subs.set(sub, group.label);
      subSummaries.set(row, subs);
    }
    const cells = cellsByPath.get(owner) ?? new Map<string, number>();
    cells.set(column, group.count);
    cellsByPath.set(owner, cells);
  }

  const allColumns = [...columnLabels].map(([key, label]): PivotAxisValue => ({
    key,
    label,
    total:
      margins.get(marginKey([1], [key])) ??
      rowSummaries.reduce(
        (sum, row) =>
          sum + (cellsByPath.get(JSON.stringify(row.path))?.get(key) ?? 0),
        0,
      ),
  }));
  allColumns.sort(byTotal);
  const grandTotal =
    input.totalCount ?? rowSummaries.reduce((sum, row) => sum + row.count, 0);
  const columnSum = allColumns.reduce((sum, column) => sum + column.total, 0);
  const rowSum = rowSummaries.reduce((sum, row) => sum + row.count, 0);
  const canFoldColumns = columnSum <= grandTotal;
  const fold =
    canFoldColumns &&
    !input.expandColumns &&
    allColumns.length > PIVOT_VISIBLE_COLUMNS;
  const columns = fold
    ? allColumns.slice(0, PIVOT_VISIBLE_COLUMNS)
    : allColumns;
  const hidden = fold ? allColumns.slice(PIVOT_VISIBLE_COLUMNS) : [];

  const withOther = (cells: ReadonlyMap<string, number>) => {
    if (hidden.length === 0) return cells;
    const next = new Map(cells);
    const other = hidden.reduce(
      (sum, column) => sum + (cells.get(column.key) ?? 0),
      0,
    );
    if (other > 0) next.set(OTHER_COLUMN, other);
    return next;
  };

  const sortValue = (row: PivotRow) =>
    input.sort === null || input.sort.column === TOTAL_COLUMN
      ? row.total
      : (row.cells.get(input.sort.column) ?? 0);
  const orderRows = (rows: PivotRow[]) =>
    rows.sort((left, right) => {
      const none =
        Number(left.key === FILTER_NONE) - Number(right.key === FILTER_NONE);
      if (none !== 0) return none;
      if (input.sort?.column === "label")
        return (
          left.label.localeCompare(right.label) * (input.sort.desc ? -1 : 1)
        );
      const difference = sortValue(right) - sortValue(left);
      return (
        (input.sort && !input.sort.desc ? -difference : difference) ||
        left.label.localeCompare(right.label)
      );
    });

  let subOverlap = false;
  const rows = rowSummaries.map((summary): PivotRow => {
    const [key = ""] = summary.path;
    const children = [...(subSummaries.get(key) ?? [])].map(
      ([sub, label]): PivotRow => {
        const cells = cellsByPath.get(JSON.stringify([key, sub])) ?? new Map();
        const total =
          margins.get(marginKey([0, 2], [key, sub])) ??
          [...cells.values()].reduce((sum, count) => sum + count, 0);
        return {
          key: sub,
          label,
          total,
          path: [key],
          children: [],
          cells: withOther(cells),
        };
      },
    );
    if (children.reduce((sum, child) => sum + child.total, 0) > summary.count)
      subOverlap = true;
    return {
      key,
      label: summary.label,
      total: summary.count,
      path: [key],
      children: orderRows(children),
      cells: withOther(
        cellsByPath.get(JSON.stringify(summary.path)) ?? new Map(),
      ),
    };
  });

  return {
    rows: orderRows(rows),
    columns,
    hidden,
    canFoldColumns,
    grandTotal,
    overlapping: rowSum > grandTotal || !canFoldColumns || subOverlap,
  };
}

/** The group path one cell counts: row, column and, for a sub-row, its value. */
export function pivotCellPath(
  row: PivotRow,
  column: string,
  parent: PivotRow | undefined,
): string[] {
  return parent ? [parent.key, column, row.key] : [row.key, column];
}

/** The denominator a cell's share and shading read for the chosen mode. */
export function pivotBasis(input: {
  share: PivotShare;
  row: PivotRow;
  column: PivotAxisValue | undefined;
  grandTotal: number;
  maxCell: number;
}): number {
  switch (input.share) {
    case "row":
      return input.row.total;
    case "column":
      return input.column?.total ?? 0;
    case "total":
      return input.grandTotal;
    case "count":
      return input.maxCell;
  }
}

/** The largest single cell, the Count mode's shading basis. */
export function pivotMaxCell(model: PivotModel): number {
  let max = 0;
  for (const row of model.rows)
    for (const [key, count] of row.cells)
      if (key !== OTHER_COLUMN && count > max) max = count;
  return max;
}
