import type { Entity } from "@cubby/schemas/entity";
import type { OnChangeFn, RowSelectionState } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";

import type { EntityActionsEntry } from "../actions/entity-actions";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import { buildSelectColumn } from "../data-table/row-selection";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyRow as Row,
  CubbyTable as Table,
} from "../data-table/table-features";
import { ListBulkActionBar, useListBulkActions } from "./useListBulkActions";

interface UseEntitySelectionOptions<TData extends { id: string }> {
  /** Fixed for the component's lifetime — see `useEntityActions`. */
  entity: Entity;
  /** This surface's own actions, merged with the entity's declared ones. */
  bulkActions?: BulkActionsConfig<TData>;
  deleteBulkAction?: BulkAction<TData> | null;
  /** Inspect the single checked canonical row without consuming selection. */
  onInspectRow?: (row: Row<TData>) => void;
  /**
   * Rows this table refuses to select — a tree whose children are a different
   * entity than the bulk actions target, or a projection/summary sub-row that
   * is not a record at all. `buildSelectColumn` renders no checkbox for a row
   * the table won't select, rather than one that ignores the click.
   */
  canSelectRow?: (row: TData) => boolean;
}

interface UseEntitySelectionReturn<TData extends { id: string }> {
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
  renderBulkActionBar: (table: Table<TData>) => ReactNode;
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

const NO_SELECT_COLUMNS: ColumnDef<never>[] = [];

/**
 * Selection for a table built straight on `useCubbyTable`.
 *
 * The entity lists get this from `useEntityList`; every embedded table that
 * reaches for the raw table hook instead had to re-copy the same block —
 * `buildSelectColumn`, `useListBulkActions`, three table options wired to its
 * state, and the "render the bar when something is selected" ternary. That is
 * ~15 lines per surface that must agree with each other to work, which is why
 * two of them were byte-for-byte identical.
 */
export function useEntitySelection<TData extends { id: string }>({
  entity,
  bulkActions,
  deleteBulkAction,
  onInspectRow,
  canSelectRow,
}: UseEntitySelectionOptions<TData>): UseEntitySelectionReturn<TData> {
  const listBulkActions = useListBulkActions<TData>({
    entity,
    bulkActions,
    deleteBulkAction,
    onInspectRow,
  });
  const { config, state } = listBulkActions;
  const selectable = listBulkActions.enableRowSelection;

  const selectColumns = useMemo(
    () =>
      selectable
        ? [buildSelectColumn<TData>()]
        : (NO_SELECT_COLUMNS as ColumnDef<TData>[]),
    [selectable],
  );

  const enableRowSelection = useMemo(
    () =>
      canSelectRow
        ? (row: Row<TData>) => selectable && canSelectRow(row.original)
        : selectable,
    [canSelectRow, selectable],
  );

  const renderBulkActionBar = (table: Table<TData>) =>
    state.selectedCount > 0 ? (
      <ListBulkActionBar table={table} config={config} state={state} />
    ) : null;

  return {
    selectColumns,
    enableRowSelection,
    /**
     * Spread into `RTable`. A bundle rather than two props because wiring only
     * half of it is silent: the bar's actions and their dialogs must come from
     * one `useEntityActions` instance, and a surface that published the row
     * items but not the dialogs would show a bar whose every action opens
     * nothing.
     */
    tableProps: {
      rowActions: listBulkActions.rowActions,
      actionDialogs: listBulkActions.actionDialogs,
    },
    rowSelection: listBulkActions.rowSelection,
    onRowSelectionChange: listBulkActions.onRowSelectionChange,
    selectedCount: state.selectedCount,
    renderBulkActionBar,
  };
}
