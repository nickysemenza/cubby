import type { RowData } from "@tanstack/react-table";
import { useMemo } from "react";

import type { CubbyRow as Row } from "./table-features";
import { orderedGroupSections, type GroupConfig } from "./useGroupedList";

type DesktopGroupItem =
  | {
      kind: "header";
      key?: string;
      title: string;
      count: number;
      color: string;
    }
  /** groupRowIndex: position within the row's group, so zebra striping can
   *  restart at each section header instead of running through it. */
  | { kind: "row"; rowIndex: number; groupRowIndex: number };

/**
 * Groups rows and returns an interleaved array of section headers and row
 * indices for the desktop virtualizer.
 *
 * The grouped server query normally makes members contiguous, but React Query
 * keeps the previous ungrouped rows visible while that request starts. Group by
 * key here as well so the placeholder frame cannot duplicate section headers.
 * Returns null when grouping is disabled so the caller can fall back to flat
 * rendering.
 */
export function useDesktopGroupedRows<TItem extends RowData>(
  rows: Row<TItem>[],
  groupConfig: GroupConfig<TItem> | undefined,
  enabled: boolean,
): DesktopGroupItem[] | null {
  return useMemo(() => {
    if (!groupConfig || !enabled) return null;

    const groups = new Map<string, number[]>();
    for (const [rowIndex, row] of rows.entries()) {
      const key = groupConfig.keyFn(row.original) ?? "(unspecified)";
      const indexes = groups.get(key);
      if (indexes) indexes.push(rowIndex);
      else groups.set(key, [rowIndex]);
    }

    const items: DesktopGroupItem[] = [];
    for (const section of orderedGroupSections(groups, groupConfig.groups)) {
      items.push({
        kind: "header",
        key: section.serverKey,
        title: section.label,
        count: section.count,
        color: groupConfig.colorFn(section.key),
      });
      for (const [groupRowIndex, rowIndex] of section.items.entries()) {
        items.push({
          kind: "row",
          rowIndex,
          groupRowIndex,
        });
      }
    }

    return items;
  }, [rows, groupConfig, enabled]);
}
