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

interface BulkActionBarProps<TData> {
  selectedCount: number;
  selectedRows: Row<TData>[];
  actions: BulkAction<TData>[];
  onExecute: (action: BulkAction<TData>, rows: Row<TData>[]) => Promise<void>;
  onClearSelection: () => void;
  isExecuting: boolean;
  currentAction: BulkAction<TData> | null;
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
}: BulkActionBarProps<TData>) {
  const [confirmAction, setConfirmAction] = useState<BulkAction<TData> | null>(
    null,
  );

  if (selectedCount === 0) return null;

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
                <Spinner className="mr-1 h-3 w-3" />
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
          <X className="h-3 w-3" />
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
