import type { RowData } from "@tanstack/react-table";
import { Checkbox } from "~/components/ui/checkbox";
import type { CubbyColumnDef } from "./table-features";

/**
 * Builds the leading row-selection checkbox column shared by every entity list.
 *
 * Range behavior comes from TanStack v9. Base UI exposes the native initiating
 * event separately from its boolean value, so the adapter below restores the
 * checkbox-shaped event the table handler expects.
 */
export function buildSelectColumn<T extends RowData>(): CubbyColumnDef<T> {
  return {
    id: "select",
    header: ({ table }) => (
      // Wrapper stops propagation since Base UI Checkbox doesn't pass onClick to the DOM element
      // biome-ignore lint/a11y/noStaticElementInteractions: wrapper exists only to stop event propagation
      <div role="presentation" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={
            table.getIsSomePageRowsSelected() &&
            !table.getIsAllPageRowsSelected()
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      </div>
    ),
    cell: ({ row }) =>
      // A row the table won't select gets no checkbox at all, rather than one
      // that silently ignores the click. `enableRowSelection` can be a
      // predicate (a tree whose children belong to a different entity than the
      // bulk actions target — see `EntityListTreeConfig.rowIsEntity`).
      !row.getCanSelect() ? null : (
        // biome-ignore lint/a11y/noStaticElementInteractions: wrapper exists only to stop event propagation
        <div role="presentation" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(checked, details) =>
              row.getToggleSelectedHandler({ selectChildren: false })({
                target: { checked },
                nativeEvent: details.event,
              })
            }
            aria-label="Select row"
          />
        </div>
      ),
    enableSorting: false,
    enableHiding: false,
    enableCellSelection: false,
    size: 40,
    minSize: 40,
    maxSize: 72,
  };
}
