import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { EntityActionsEntry } from "../../entity/actions/entity-actions";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyRow as Row,
  CubbyTable as Table,
} from "../data-table/table-features";

export interface UseEntitySelectionReturn<TData extends { id: string }> {
  /**
   * Spread at the head of the columns array. Empty — not a disabled column —
   * when nothing is selectable, so a table with no actions grows no dead
   * checkbox gutter.
   */
  selectColumns: ColumnDef<TData>[];
  enableRowSelection: boolean | ((row: Row<TData>) => boolean);
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState> | undefined;
  selectedCount: number;
  /**
   * The selection bar, or null while nothing is selected. Takes the table
   * because the bar reads the selected rows off it, and the table is built
   * from the columns this hook contributes to.
   */
  renderBulkActionBar: (table: Table<TData> | null) => ReactNode;
  /**
   * Spread into `RTable`. A bundle rather than two props because wiring only
   * half of it is silent: the bar's actions and their dialogs must come from
   * one `useEntityActions` instance, and a surface that published the row
   * items but not the dialogs would show a bar whose every action opens
   * nothing.
   */
  tableProps: {
    rowActions: EntityActionsEntry;
    actionDialogs: ReactNode;
  };
}
