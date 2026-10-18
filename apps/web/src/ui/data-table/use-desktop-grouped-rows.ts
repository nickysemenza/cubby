import type { RowData } from "@tanstack/react-table";
import { useMemo, type ReactNode } from "react";

import type { CubbyRow as Row } from "./table-features";
import { type GroupConfig, groupSections } from "./use-grouped-list";

type DesktopGroupItem =
  | {
      kind: "header";
      key: string;
      title: string;
      count: number;
      onFilter?: () => void;
      onHide?: () => void;
      aside?: ReactNode;
      actions?: ReactNode;
    }
  /** groupRowIndex: position within the row's group, so zebra striping can
   *  restart at each section header instead of running through it. */
  | { kind: "row"; rowIndex: number; groupRowIndex: number }
  /** An expanded row's full-width detail (`RTable`'s `renderRowDetail`). */
  | { kind: "detail"; rowIndex: number };

/**
 * The table's rows interleaved with section headers and expanded row details
 * for the desktop virtualizer, or null when the list is neither grouped nor
 * showing a detail. An expanded row's children stay in their parent's section.
 * `detailRowIds` are the rows whose detail is open, in no particular order.
 */
export function useDesktopGroupedRows<TItem extends RowData>(
  rows: Row<TItem>[],
  groupConfig: GroupConfig | undefined,
  detailRowIds?: ReadonlySet<string>,
): DesktopGroupItem[] | null {
  return useMemo(() => {
    const detailed = (detailRowIds?.size ?? 0) > 0;
    if (!groupConfig && !detailed) return null;
    const items: DesktopGroupItem[] = groupConfig
      ? groupSections(
          rows.map((row, rowIndex) => ({ row, rowIndex })),
          groupConfig,
          ({ row }) => row.depth > 0,
        ).flatMap((section): DesktopGroupItem[] => [
          {
            kind: "header",
            key: section.key,
            title: section.label,
            count: section.count,
            onFilter: section.onFilter,
            onHide: section.onHide,
            aside: section.aside,
            actions: section.actions,
          },
          ...section.items.map(({ rowIndex }, groupRowIndex) => ({
            kind: "row" as const,
            rowIndex,
            groupRowIndex,
          })),
        ])
      : rows.map((_, rowIndex) => ({
          kind: "row" as const,
          rowIndex,
          groupRowIndex: rowIndex,
        }));
    if (!detailed) return items;
    return items.flatMap((item): DesktopGroupItem[] =>
      item.kind === "row" && detailRowIds?.has(rows[item.rowIndex]?.id ?? "")
        ? [item, { kind: "detail", rowIndex: item.rowIndex }]
        : [item],
    );
  }, [rows, groupConfig, detailRowIds]);
}
