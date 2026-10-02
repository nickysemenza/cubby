/** One column of a cross-tab. `key` is the caller's own lookup id for cells. */
export interface CrossTabColumn<C> {
  key: string;
  data: C;
  /**
   * Columns sharing a groupKey render under one spanning header cell. Only
   * *consecutive* columns group — see {@link groupColumnRuns}.
   */
  groupKey?: string;
}

export interface ColumnRun<C> {
  /** `undefined` for ungrouped columns, which always run one at a time. */
  groupKey: string | undefined;
  columns: CrossTabColumn<C>[];
}

/**
 * Collapse consecutive same-`groupKey` columns into runs, for a spanning
 * header row.
 *
 * Only consecutive columns merge. Two separated runs of the same key stay two
 * runs, because the alternative — gathering them — would mean reordering the
 * columns out from under the caller, and a cross-tab's column order is the
 * caller's decision (the shopping matrix orders by meal date, and silently
 * re-sorting would scramble it). A caller that wants one span per key sorts by
 * that key before calling.
 *
 * Ungrouped columns never merge with each other, so a `colSpan` built from
 * these runs always covers exactly the columns rendered beneath it.
 */
export function groupColumnRuns<C>(
  columns: readonly CrossTabColumn<C>[],
): ColumnRun<C>[] {
  const runs: ColumnRun<C>[] = [];
  for (const column of columns) {
    const last = runs.at(-1);
    if (
      last &&
      column.groupKey !== undefined &&
      last.groupKey === column.groupKey
    ) {
      last.columns.push(column);
      continue;
    }
    runs.push({ groupKey: column.groupKey, columns: [column] });
  }
  return runs;
}
