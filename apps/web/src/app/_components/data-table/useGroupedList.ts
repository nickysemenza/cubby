import type { ListGroupSummary } from "@cubby/schemas/pagination";
import { useMemo } from "react";

export interface GroupConfig<TItem> {
  /** DB column name for server-side group ordering (e.g., "type", "category") */
  field: string;
  /** Extract the group key from an item. Null/undefined becomes "(unspecified)". */
  keyFn: (item: TItem) => string | null | undefined;
  colorFn: (key: string) => string;
  /** Ordered summaries of the entire filtered set, including unloaded pages. */
  groups?: readonly ListGroupSummary[];
}

type GroupedVirtualItem<TItem> =
  | {
      kind: "header";
      key?: string;
      title: string;
      count: number;
      color: string;
    }
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

    const sections = groupConfig.groups
      ? groupConfig.groups.map(
          (summary) => [summary.key, groups.get(summary.key) ?? []] as const,
        )
      : Array.from(groups.entries()).sort(([a], [b]) => {
          if (a === "(unspecified)") return 1;
          if (b === "(unspecified)") return -1;
          return a.localeCompare(b);
        });

    const result: GroupedVirtualItem<TItem>[] = [];
    for (const [key, items] of sections) {
      const summary = groupConfig.groups?.find((group) => group.key === key);
      result.push({
        kind: "header",
        key: summary?.key,
        title: summary?.label ?? key,
        count: summary?.count ?? items.length,
        color: groupConfig.colorFn(key),
      });
      for (const item of items) {
        result.push({ kind: "row", item });
      }
    }

    return result;
  }, [data, groupConfig, enabled]);
}
