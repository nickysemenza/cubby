import type {
  OnChangeFn,
  RowData,
  RowSelectionState,
} from "@tanstack/react-table";
import { functionalUpdate } from "@tanstack/react-table";
import { useCallback, useRef, useState } from "react";

import {
  type BulkAction,
  type BulkActionsConfig,
  resolveBulkActionAvailability,
} from "./bulk-actions.types";
import type { CubbyRow as Row } from "./table-features";

interface UseBulkActionsOptions<TData extends RowData> {
  config: BulkActionsConfig<TData>;
}

const supportsSelectionCount = <TData extends RowData>(
  action: BulkAction<TData>,
  count: number,
) =>
  count > 0 &&
  (action.minSelection == null || count >= action.minSelection) &&
  (action.maxSelection == null || count <= action.maxSelection);

export interface UseBulkActionsReturn<TData extends RowData> {
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  selectedCount: number;
  getAvailableActions: (selectedRows: Row<TData>[]) => BulkAction<TData>[];
  executeAction: (
    action: BulkAction<TData>,
    selectedRows: Row<TData>[],
  ) => Promise<void>;
  isExecuting: boolean;
  currentAction: BulkAction<TData> | null;
  clearSelection: () => void;
}

export function useBulkActions<TData extends RowData>({
  config,
}: UseBulkActionsOptions<TData>): UseBulkActionsReturn<TData> {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const selectionRef = useRef(rowSelection);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentAction, setCurrentAction] = useState<BulkAction<TData> | null>(
    null,
  );

  const selectedCount = Object.keys(rowSelection).filter(
    (k) => rowSelection[k],
  ).length;

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = useCallback(
    (updater) => {
      // Table updaters read live rows. Resolve at the event boundary, before
      // optimistic deletion can remove a row while React replays an update.
      const next = functionalUpdate(updater, selectionRef.current);
      selectionRef.current = next;
      setRowSelection(next);
    },
    [],
  );

  const getAvailableActions = useCallback(
    (selectedRows: Row<TData>[]) => {
      return config.actions.filter((action) => {
        const count = selectedRows.length;
        if (!supportsSelectionCount(action, count)) return false;
        return (
          resolveBulkActionAvailability(action, selectedRows).status !==
          "hidden"
        );
      });
    },
    [config.actions],
  );

  const executeAction = useCallback(
    async (action: BulkAction<TData>, selectedRows: Row<TData>[]) => {
      if (
        !supportsSelectionCount(action, selectedRows.length) ||
        resolveBulkActionAvailability(action, selectedRows).status !==
          "available"
      ) {
        return;
      }

      setIsExecuting(true);
      setCurrentAction(action);

      try {
        const result = await action.onExecute(selectedRows);

        if (
          result.success &&
          !action.preserveSelection &&
          config.clearSelectionOnComplete !== false
        ) {
          onRowSelectionChange({});
        }
      } finally {
        setIsExecuting(false);
        setCurrentAction(null);
      }
    },
    [config.clearSelectionOnComplete, onRowSelectionChange],
  );

  const clearSelection = useCallback(() => {
    onRowSelectionChange({});
  }, [onRowSelectionChange]);

  return {
    rowSelection,
    onRowSelectionChange,
    selectedCount,
    getAvailableActions,
    executeAction,
    isExecuting,
    currentAction,
    clearSelection,
  };
}
