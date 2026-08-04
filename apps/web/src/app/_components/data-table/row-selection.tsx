import type { ColumnDef } from "@tanstack/react-table";
import type { MutableRefObject } from "react";
import { Checkbox } from "~/components/ui/checkbox";

/**
 * Builds the leading row-selection checkbox column shared by every entity list.
 *
 * Shift-clicking a row checkbox selects the contiguous range between the previously
 * clicked row (the "anchor") and the clicked row. The anchor is tracked by row **id**
 * (not index) so the range follows visual order even when the table is sorted/filtered.
 *
 * @param lastSelectedIdRef - mutable anchor: id of the last row whose checkbox was clicked
 * @param shiftKeyRef - mutable flag set on click-capture, read in onCheckedChange
 */
export function buildSelectColumn<T>(
  lastSelectedIdRef: MutableRefObject<string | null>,
  shiftKeyRef: MutableRefObject<boolean>,
): ColumnDef<T> {
  return {
    id: "select",
    header: ({ table }) => (
      // Wrapper stops propagation since Base UI Checkbox doesn't pass onClick to the DOM element
      // biome-ignore lint/a11y/noStaticElementInteractions: wrapper exists only to stop event propagation
      <div role="presentation" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      </div>
    ),
    cell: ({ row, table }) =>
      // A row the table won't select gets no checkbox at all, rather than one
      // that silently ignores the click. `enableRowSelection` can be a
      // predicate (a tree whose children belong to a different entity than the
      // bulk actions target — see `EntityListTreeConfig.rowIsEntity`).
      !row.getCanSelect() ? null : (
        // Capture-phase runs before the Base UI Checkbox's onCheckedChange, so shiftKeyRef
        // is set in time. onClick (bubble phase) only stops propagation to the row handler.
        // biome-ignore lint/a11y/noStaticElementInteractions: wrapper exists only to stop event propagation
        <div
          role="presentation"
          onClickCapture={(e) => {
            shiftKeyRef.current = e.shiftKey;
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => {
              const rows = table.getRowModel().rows;
              const anchorId = lastSelectedIdRef.current;
              const anchorPos =
                shiftKeyRef.current && anchorId != null
                  ? rows.findIndex((r) => r.id === anchorId)
                  : -1;

              if (anchorPos !== -1) {
                const currentPos = rows.findIndex((r) => r.id === row.id);
                const [from, to] = [
                  Math.min(anchorPos, currentPos),
                  Math.max(anchorPos, currentPos),
                ];
                const updates: Record<string, boolean> = {};
                for (let i = from; i <= to; i++) {
                  const r = rows[i];
                  // Skip unselectable rows: this branch writes the selection map
                  // directly, so it would otherwise select rows the table just
                  // refused to give a checkbox.
                  if (r?.getCanSelect()) updates[r.id] = !!value;
                }
                table.setRowSelection((prev) => ({ ...prev, ...updates }));
              } else {
                row.toggleSelected(!!value);
              }

              lastSelectedIdRef.current = row.id;
            }}
            aria-label="Select row"
          />
        </div>
      ),
    enableSorting: false,
    enableHiding: false,
    meta: { className: "w-10" },
  };
}
