import { useMemo } from "react";

export interface GroupConfig<TItem> {
  /** DB column name for server-side group ordering (e.g., "type", "category") */
  field: string;
  /** Extract the group key from an item. Null/undefined becomes "(unspecified)". */
  keyFn: (item: TItem) => string | null | undefined;
  colorFn: (key: string) => string;
}

type GroupedVirtualItem<TItem> =
  | { kind: "header"; title: string; count: number; color: string }
  | { kind: "row"; item: TItem };

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
    for (const [title, items] of sections) {
      result.push({
        kind: "header",
        title,
        count: items.length,
        color: groupConfig.colorFn(title),
      });
      for (const item of items) {
        result.push({ kind: "row", item });
      }
    }

    return result;
  }, [data, groupConfig, enabled]);
}
