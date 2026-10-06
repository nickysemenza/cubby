import type { RowData, RowSelectionState } from "@tanstack/react-table";

import { Checkbox } from "~/ui/primitives/checkbox";

import type { CubbyCellContext, CubbyColumnDef } from "./table-features";

/**
 * Drop selected row keys that no longer belong to the current canonical
 * result set. TanStack intentionally preserves controlled selection across
 * data replacement; entity actions cannot, because an invisible/deleted row
 * must never remain an executable target.
 */
export function reconcileRowSelection(
  current: RowSelectionState,
  availableRowIds: ReadonlySet<string>,
): RowSelectionState {
  let changed = false;
  const next: RowSelectionState = {};
  for (const [id, selected] of Object.entries(current)) {
    if (selected && availableRowIds.has(id)) {
      next[id] = true;
    } else {
      changed = true;
    }
  }
  return changed ? next : current;
}

function SelectColumnHeader<T extends RowData>({
  table,
}: Pick<CubbyCellContext<T>, "table">) {
  return (
    // Wrapper stops propagation since Base UI Checkbox doesn't pass onClick to the DOM element
    <div role="presentation" onClick={(e) => e.stopPropagation()}>
      <Checkbox
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={
          table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    </div>
  );
}

function SelectColumnCell<T extends RowData>({
  row,
}: Pick<CubbyCellContext<T>, "row">) {
  return (
    // A row the table won't select gets no checkbox at all, rather than one
    // that silently ignores the click. `enableRowSelection` can be a
    // predicate (a tree whose children belong to a different entity than the
    // bulk actions target — see `EntityListTreeConfig.rowIsEntity`).
    !row.getCanSelect() ? null : (
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
    )
  );
}

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
    // flexRender treats these callbacks as component types. Column metadata
    // can refresh while a checkbox holds focus; keep its type stable.
    header: SelectColumnHeader,
    cell: SelectColumnCell,
    enableSorting: false,
    enableHiding: false,
    enablePinning: false,
    enableCellSelection: false,
    meta: { entityColumnRole: "selection" },
    size: 40,
    minSize: 40,
    maxSize: 72,
  };
}
