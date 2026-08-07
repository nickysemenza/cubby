import type { Row } from "@tanstack/react-table";
import { X } from "lucide-react";
import { Row as LayoutRow } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type { BulkAction } from "./bulk-actions.types";

export interface BulkActionBarProps<TData> {
  selectedCount: number;
  selectedRows: Row<TData>[];
  actions: BulkAction<TData>[];
  onExecute: (action: BulkAction<TData>, rows: Row<TData>[]) => Promise<void>;
  onClearSelection: () => void;
  isExecuting: boolean;
  currentAction: BulkAction<TData> | null;
  /**
   * "Select all N matching" affordance. Shown when every loaded row is
   * selected but the filtered set has more on the server. Present only in
   * infinite mode where more pages can be pulled in.
   */
  selectAllMatching?: {
    /** Total rows matching the current filters (server count). */
    totalCount: number;
    /** Rows currently in memory (all selected when this shows). */
    loadedCount: number;
    /** Load every remaining page, then select all. */
    onSelectAll: () => Promise<void>;
    isSelectingAll: boolean;
  };
  /** Stale placeholder rows are visible but must not be acted on. */
  disabled?: boolean;
}

/**
 * Toolbar component that appears when rows are selected.
 * Shows selection count, available actions, and a clear button.
 */
export function BulkActionBar<TData>({
  selectedCount,
  selectedRows,
  actions,
  onExecute,
  onClearSelection,
  isExecuting,
  currentAction,
  selectAllMatching,
  disabled = false,
}: BulkActionBarProps<TData>) {
  if (selectedCount === 0) return null;

  // Offer "select all N" only once every loaded row is selected and the
  // server has more matching rows than are in memory.
  const showSelectAll =
    selectAllMatching != null &&
    selectedCount >= selectAllMatching.loadedCount &&
    selectAllMatching.loadedCount < selectAllMatching.totalCount;

  const handleActionClick = (action: BulkAction<TData>) => {
    if (disabled) return;
    onExecute(action, selectedRows);
  };

  return (
    <LayoutRow
      align="center"
      gap="sm"
      className="rounded-md bg-primary/10 px-4 py-2"
    >
      <span className="font-medium text-sm">{selectedCount} selected</span>

      {showSelectAll && selectAllMatching && (
        <Button
          variant="ghost"
          size="sm"
          className="text-primary"
          onClick={() => void selectAllMatching.onSelectAll()}
          disabled={disabled || isExecuting || selectAllMatching.isSelectingAll}
        >
          {selectAllMatching.isSelectingAll && (
            <Spinner className="mr-1 size-3" />
          )}
          Select all {selectAllMatching.totalCount}
        </Button>
      )}

      {/* Wraps because the action count is per-entity and open-ended — Tasks
          already carries five before the shared Copy and Delete. */}
      <LayoutRow align="center" gap="xs" wrap>
        {actions.map((action) => (
          <Button
            key={action.id}
            variant="ghost"
            size="sm"
            onClick={() => handleActionClick(action)}
            disabled={disabled || isExecuting}
          >
            {isExecuting && currentAction?.id === action.id ? (
              <Spinner className="mr-1 size-3" />
            ) : action.icon ? (
              <span className="mr-1">{action.icon}</span>
            ) : null}
            {action.label}
          </Button>
        ))}
      </LayoutRow>

      <Button
        variant="ghost"
        size="sm"
        onClick={onClearSelection}
        disabled={disabled || isExecuting}
        className="ml-auto"
      >
        <X className="size-3" />
        <span className="sr-only">Clear selection</span>
      </Button>
    </LayoutRow>
  );
}
