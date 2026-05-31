import { useMemo } from "react";

export interface GroupConfig<TItem> {
  /** DB column name for server-side group ordering (e.g., "type", "category") */
  field: string;
  /** Extract the group key from an item. Null/undefined becomes "(unspecified)". */
  keyFn: (item: TItem) => string | null | undefined;
  /** Get the accent color for a group key */
  colorFn: (key: string) => string;
}

type GroupedVirtualItem<TItem> =
  | { kind: "header"; title: string; count: number; color: string }
  | { kind: "row"; item: TItem; index: number };

/**
 * Groups flat data into sections and flattens into a virtualizer-compatible list
 * of interleaved headers and rows. Sections are sorted alphabetically with
 * "(unspecified)" last.
 *
 * Used by mobile list view for client-side grouping. Desktop tables use
 * `useDesktopGroupedRows` which relies on server-side ordering (groupBy param).
 */
export function useGroupedList<TItem>(
  data: TItem[],
  groupConfig: GroupConfig<TItem> | undefined,
  enabled: boolean,
): GroupedVirtualItem<TItem>[] | null {
  return useMemo(() => {
    if (!groupConfig || !enabled) return null;

    const groups = new Map<string, TItem[]>();

    for (const item of data) {
      const key = groupConfig.keyFn(item) || "(unspecified)";
      const existing = groups.get(key);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(key, [item]);
      }
    }

    const sections = Array.from(groups.entries());
    sections.sort(([a], [b]) => {
      if (a === "(unspecified)") return 1;
      if (b === "(unspecified)") return -1;
      return a.localeCompare(b);
    });

    const result: GroupedVirtualItem<TItem>[] = [];
    let rowIndex = 0;
    for (const [title, items] of sections) {
      result.push({
        kind: "header",
        title,
        count: items.length,
        color: groupConfig.colorFn(title),
      });
      for (const item of items) {
        result.push({ kind: "row", item, index: rowIndex++ });
      }
    }

    return result;
  }, [data, groupConfig, enabled]);
}
