import type { OnChangeFn, Row, RowSelectionState } from "@tanstack/react-table";
import { useCallback, useState } from "react";
import type { BulkAction, BulkActionsConfig } from "./bulk-actions.types";

interface UseBulkActionsOptions<TData> {
  config: BulkActionsConfig<TData>;
}

export interface UseBulkActionsReturn<TData> {
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

export function useBulkActions<TData>({
  config,
}: UseBulkActionsOptions<TData>): UseBulkActionsReturn<TData> {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentAction, setCurrentAction] = useState<BulkAction<TData> | null>(
    null,
  );

  const selectedCount = Object.keys(rowSelection).filter(
    (k) => rowSelection[k],
  ).length;

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = useCallback(
    (updater) => {
      setRowSelection((prev) =>
        typeof updater === "function" ? updater(prev) : updater,
      );
    },
    [],
  );

  const getAvailableActions = useCallback(
    (selectedRows: Row<TData>[]) => {
      return config.actions.filter((action) => {
        const count = selectedRows.length;
        if (count === 0) return false;
        if (action.minSelection && count < action.minSelection) return false;
        if (action.maxSelection && count > action.maxSelection) return false;
        return true;
      });
    },
    [config.actions],
  );

  const executeAction = useCallback(
    async (action: BulkAction<TData>, selectedRows: Row<TData>[]) => {
      setIsExecuting(true);
      setCurrentAction(action);

      try {
        const result = await action.onExecute(selectedRows);

        if (result.success && config.clearSelectionOnComplete !== false) {
          setRowSelection({});
        }
      } finally {
        setIsExecuting(false);
        setCurrentAction(null);
      }
    },
    [config.clearSelectionOnComplete],
  );

  const clearSelection = useCallback(() => {
    setRowSelection({});
  }, []);

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
