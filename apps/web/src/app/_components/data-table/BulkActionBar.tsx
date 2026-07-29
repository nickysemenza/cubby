import type { Row } from "@tanstack/react-table";
import { X } from "lucide-react";
import { useState } from "react";
import { Row as LayoutRow } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
}: BulkActionBarProps<TData>) {
  const [confirmAction, setConfirmAction] = useState<BulkAction<TData> | null>(
    null,
  );

  if (selectedCount === 0) return null;

  // Offer "select all N" only once every loaded row is selected and the
  // server has more matching rows than are in memory.
  const showSelectAll =
    selectAllMatching != null &&
    selectedCount >= selectAllMatching.loadedCount &&
    selectAllMatching.loadedCount < selectAllMatching.totalCount;

  const handleActionClick = (action: BulkAction<TData>) => {
    if (action.requiresConfirmation) {
      setConfirmAction(action);
    } else {
      onExecute(action, selectedRows);
    }
  };

  const handleConfirm = () => {
    if (confirmAction) {
      onExecute(confirmAction, selectedRows);
      setConfirmAction(null);
    }
  };

  const getConfirmationContent = () => {
    if (!confirmAction) return null;

    // Custom confirmation content takes precedence
    if (confirmAction.renderConfirmation) {
      return confirmAction.renderConfirmation(selectedRows);
    }

    // Default message
    return `Are you sure you want to ${confirmAction.label.toLowerCase()} ${selectedCount} item${selectedCount === 1 ? "" : "s"}?`;
  };

  return (
    <>
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
            disabled={isExecuting || selectAllMatching.isSelectingAll}
          >
            {selectAllMatching.isSelectingAll && (
              <Spinner className="mr-1 size-3" />
            )}
            Select all {selectAllMatching.totalCount}
          </Button>
        )}

        <LayoutRow align="center" gap="xs">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant="ghost"
              size="sm"
              onClick={() => handleActionClick(action)}
              disabled={isExecuting}
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
          disabled={isExecuting}
          className="ml-auto"
        >
          <X className="size-3" />
          <span className="sr-only">Clear selection</span>
        </Button>
      </LayoutRow>

      {/* Confirmation Dialog */}
      <AlertDialog
        open={!!confirmAction}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {confirmAction?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              {getConfirmationContent()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>
              {confirmAction?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
