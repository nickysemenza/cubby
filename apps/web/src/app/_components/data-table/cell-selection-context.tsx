import * as React from "react";

/**
 * Column ids that are never part of spreadsheet-style cell selection: the
 * leading row-select checkbox and the trailing row-actions menu. Kept in ONE
 * place so `useCellSelection` (which builds the selectable-column list) and
 * `DesktopDataRow` (which tags selectable `<td>`s with `data-cell-col`) agree
 * on the exact same exclusion set — if they drift, column-index math skews.
 */
export const NON_SELECTABLE_COLUMN_IDS = new Set(["select", "actions"]);

/**
 * DOM `CustomEvent` name dispatched on a cell's edit-trigger button to open its
 * editor from the keyboard (Enter in the selection grid). The trigger listens
 * for it (see `cell-edit-trigger.tsx`); the selection hook dispatches it.
 */
export const CELL_EDIT_EVENT = "cubby:cell-edit";

/**
 * True inside an RTable that has spreadsheet-style cell selection enabled
 * (desktop list tables). False on detail pages, dialogs, and mobile — where
 * editable cells keep the original click-to-edit behavior. Read by
 * `CellEditTrigger` to switch between select-then-edit and click-to-edit.
 */
export const CellSelectionContext = React.createContext(false);
