import type { RowData } from "@tanstack/react-table";
import { useMemo } from "react";

import type { CubbyRow as Row } from "./table-features";
import { type GroupConfig, groupSections } from "./use-grouped-list";

type DesktopGroupItem =
  | {
      kind: "header";
      key: string;
      title: string;
      count: number;
      onFilter?: () => void;
    }
  /** groupRowIndex: position within the row's group, so zebra striping can
   *  restart at each section header instead of running through it. */
  | { kind: "row"; rowIndex: number; groupRowIndex: number };

/**
 * The table's rows interleaved with section headers for the desktop
 * virtualizer, or null when the list is not grouped. An expanded row's
 * children stay in their parent's section.
 */
export function useDesktopGroupedRows<TItem extends RowData>(
  rows: Row<TItem>[],
  groupConfig: GroupConfig | undefined,
): DesktopGroupItem[] | null {
  return useMemo(() => {
    if (!groupConfig) return null;
    const indexed = rows.map((row, rowIndex) => ({ row, rowIndex }));
    return groupSections(
      indexed,
      groupConfig,
      ({ row }) => row.depth > 0,
    ).flatMap((section): DesktopGroupItem[] => [
      {
        kind: "header",
        key: section.key,
        title: section.label,
        count: section.count,
        onFilter: section.onFilter,
      },
      ...section.items.map(({ rowIndex }, groupRowIndex) => ({
        kind: "row" as const,
        rowIndex,
        groupRowIndex,
      })),
    ]);
  }, [rows, groupConfig]);
}
