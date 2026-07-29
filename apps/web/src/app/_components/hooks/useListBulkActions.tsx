import type { Row, Table } from "@tanstack/react-table";
import { useMemo } from "react";
import {
  BulkActionBar,
  type BulkActionBarProps,
} from "../data-table/BulkActionBar";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import {
  type UseBulkActionsReturn,
  useBulkActions,
} from "../data-table/useBulkActions";

export function useListBulkActions<TData>({
  bulkActions,
  deleteBulkAction,
}: {
  bulkActions?: BulkActionsConfig<TData>;
  deleteBulkAction?: BulkAction<TData> | null;
}) {
  const config = useMemo((): BulkActionsConfig<TData> | undefined => {
    if (!deleteBulkAction && !bulkActions) return undefined;
    return {
      ...bulkActions,
      actions: [
        ...(bulkActions?.actions ?? []),
        ...(deleteBulkAction ? [deleteBulkAction] : []),
      ],
    };
  }, [bulkActions, deleteBulkAction]);
  const emptyConfig = useMemo<BulkActionsConfig<TData>>(
    () => ({ actions: [] }),
    [],
  );
  const state = useBulkActions({ config: config ?? emptyConfig });

  return {
    config,
    state,
    enableRowSelection: config !== undefined,
    rowSelection: config ? state.rowSelection : {},
    onRowSelectionChange: config ? state.onRowSelectionChange : undefined,
  };
}

export function ListBulkActionBar<TData>({
  table,
  config,
  state,
  selectAllMatching,
}: {
  table: Table<TData>;
  config?: BulkActionsConfig<TData>;
  state: UseBulkActionsReturn<TData>;
  selectAllMatching?: BulkActionBarProps<TData>["selectAllMatching"];
}) {
  if (!config) return null;
  const selectedRows: Row<TData>[] = table.getFilteredSelectedRowModel().rows;
  return (
    <BulkActionBar
      selectedCount={state.selectedCount}
      selectedRows={selectedRows}
      actions={state.getAvailableActions(selectedRows)}
      onExecute={state.executeAction}
      onClearSelection={state.clearSelection}
      isExecuting={state.isExecuting}
      currentAction={state.currentAction}
      selectAllMatching={selectAllMatching}
    />
  );
}
