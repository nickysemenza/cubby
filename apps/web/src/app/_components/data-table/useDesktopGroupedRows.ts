import type { Row } from "@tanstack/react-table";
import { useMemo } from "react";
import type { GroupConfig } from "./useGroupedList";

type DesktopGroupItem =
  | { kind: "header"; title: string; count: number; color: string }
  | { kind: "row"; rowIndex: number };

/**
 * Detects group boundaries in server-ordered rows and returns an interleaved
 * array of section headers and row indices for the desktop virtualizer.
 *
 * Trusts server-side ordering (groupBy param ensures group members are contiguous).
 * Returns null when grouping is disabled so the caller can fall back to flat rendering.
 */
export function useDesktopGroupedRows<TItem>(
  rows: Row<TItem>[],
  groupConfig: GroupConfig<TItem> | undefined,
  enabled: boolean,
): DesktopGroupItem[] | null {
  return useMemo(() => {
    if (!groupConfig || !enabled || rows.length === 0) return null;

    // First pass: count members per group (preserving server order)
    const groups: Array<{ key: string; startIndex: number; count: number }> =
      [];
    let currentKey: string | null = null;

    for (let i = 0; i < rows.length; i++) {
      const key = groupConfig.keyFn(rows[i].original) ?? "(unspecified)";
      if (key !== currentKey) {
        groups.push({ key, startIndex: i, count: 1 });
        currentKey = key;
      } else {
        groups[groups.length - 1].count++;
      }
    }

    // Second pass: build interleaved items
    const items: DesktopGroupItem[] = [];
    for (const group of groups) {
      items.push({
        kind: "header",
        title: group.key,
        count: group.count,
        color: groupConfig.colorFn(group.key),
      });
      for (let i = group.startIndex; i < group.startIndex + group.count; i++) {
        items.push({ kind: "row", rowIndex: i });
      }
    }

    return items;
  }, [rows, groupConfig, enabled]);
}
