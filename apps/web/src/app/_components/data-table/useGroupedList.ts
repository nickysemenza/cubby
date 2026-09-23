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

export function orderedGroupSections<T>(
  groups: ReadonlyMap<string, T[]>,
  summaries?: readonly ListGroupSummary[],
) {
  const seen = new Set(summaries?.map((group) => group.key));
  return [
    ...(summaries?.map((group) => ({
      key: group.key,
      serverKey: group.key,
      label: group.label,
      count: group.count,
      items: groups.get(group.key) ?? [],
    })) ?? []),
    ...Array.from(groups.entries())
      .filter(([key]) => !seen.has(key))
      .map(([key, items]) => ({
        key,
        serverKey: undefined,
        label: key,
        count: items.length,
        items,
      })),
  ];
}

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

    const sortedGroups = groupConfig.groups
      ? groups
      : new Map(
          Array.from(groups.entries()).sort(([a], [b]) => {
            if (a === "(unspecified)") return 1;
            if (b === "(unspecified)") return -1;
            return a.localeCompare(b);
          }),
        );

    const result: GroupedVirtualItem<TItem>[] = [];
    for (const section of orderedGroupSections(
      sortedGroups,
      groupConfig.groups,
    )) {
      result.push({
        kind: "header",
        key: section.serverKey,
        title: section.label,
        count: section.count,
        color: groupConfig.colorFn(section.key),
      });
      for (const item of section.items) {
        result.push({ kind: "row", item });
      }
    }

    return result;
  }, [data, groupConfig, enabled]);
}
