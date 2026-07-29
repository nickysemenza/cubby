import type { OnChangeFn, Row, RowSelectionState } from "@tanstack/react-table";
import { useCallback, useState } from "react";
import type { BulkAction, BulkActionsConfig } from "./bulk-actions.types";

interface UseBulkActionsOptions<TData> {
  config: BulkActionsConfig<TData>;
}

export interface UseBulkActionsReturn<TData> {
  /** Current row selection state (for useTableConfig) */
  rowSelection: RowSelectionState;
  /** Selection change handler (for useTableConfig) */
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  /** Number of currently selected rows */
  selectedCount: number;
  /** Get available actions for current selection */
  getAvailableActions: (selectedRows: Row<TData>[]) => BulkAction<TData>[];
  /** Execute an action */
  executeAction: (
    action: BulkAction<TData>,
    selectedRows: Row<TData>[],
  ) => Promise<void>;
  /** Whether an action is currently executing */
  isExecuting: boolean;
  /** Current action being executed (for UI feedback) */
  currentAction: BulkAction<TData> | null;
  /** Clear selection */
  clearSelection: () => void;
}

/**
 * Hook for managing bulk action state and execution.
 *
 * Handles:
 * - Row selection state management
 * - Action availability filtering (min/max selection)
 * - Action execution with loading state
 * - Selection clearing after successful actions
 */
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
