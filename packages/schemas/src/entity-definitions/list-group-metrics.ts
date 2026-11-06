/**
 * The grouped list reader's metric roster (`list.metrics`): every key of a
 * `totals` entry with `group`, then each rail field declared `total: "sum"`,
 * once each. The manifest compiler validates the roster as additive SQL
 * values, so a summed rail column reuses the reader's per-group sums
 * (`readGroupedQuery`) with no new request input.
 */
export const listGroupMetricKeys = (
  totals: readonly {
    readonly keys: readonly string[];
    readonly group: boolean;
  }[],
  rail: readonly { readonly field: string; readonly total?: "sum" }[] = [],
): string[] => [
  ...new Set([
    ...totals.flatMap((total) => (total.group ? total.keys : [])),
    ...rail.flatMap((column) => (column.total === "sum" ? [column.field] : [])),
  ]),
];
