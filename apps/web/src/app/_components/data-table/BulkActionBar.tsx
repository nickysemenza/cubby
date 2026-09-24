import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import type { RowData } from "@tanstack/react-table";

import { Row as LayoutRow } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

import {
  type BulkAction,
  resolveBulkActionAvailability,
} from "./bulk-actions.types";
import type { CubbyRow as Row } from "./table-features";

export interface BulkActionBarProps<TData extends RowData> {
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
export function BulkActionBar<TData extends RowData>({
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
    if (
      disabled ||
      resolveBulkActionAvailability(action, selectedRows).status !== "available"
    ) {
      return;
    }
    onExecute(action, selectedRows);
  };
  const orderedActions = actions
    .map((action) => ({
      action,
      availability: resolveBulkActionAvailability(action, selectedRows),
    }))
    .filter(({ availability }) => availability.status !== "hidden")
    .sort(
      (a, b) =>
        Number(a.action.tone === "destructive") -
        Number(b.action.tone === "destructive"),
    );

  return (
    <LayoutRow
      data-bulk-action-bar
      align="center"
      gap="sm"
      wrap
      className="bg-card max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--app-chrome-bottom)] max-md:z-40 max-md:min-h-12 max-md:[scrollbar-width:none] max-md:flex-nowrap max-md:overflow-x-auto max-md:overscroll-x-contain max-md:border-t max-md:border-foreground max-md:px-2 max-md:py-1 md:px-1 max-md:[&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 font-mono text-xs font-medium uppercase tabular-nums">
        {selectedCount} selected
      </span>

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
      <LayoutRow align="center" gap="xs" wrap className="max-md:flex-nowrap">
        {orderedActions.map(({ action, availability }) => {
          const disabledReason =
            availability.status === "disabled"
              ? availability.reason
              : undefined;
          return (
            <Button
              key={action.id}
              variant={action.tone === "destructive" ? "destructive" : "ghost"}
              size="sm"
              onClick={() => handleActionClick(action)}
              disabled={disabled || isExecuting || disabledReason != null}
              title={disabledReason}
              aria-label={
                disabledReason
                  ? `${action.label}, ${disabledReason}`
                  : undefined
              }
            >
              {isExecuting && currentAction?.id === action.id ? (
                <Spinner className="mr-1 size-3" />
              ) : action.icon ? (
                <span className="mr-1">{action.icon}</span>
              ) : null}
              {action.label}
            </Button>
          );
        })}
      </LayoutRow>

      <Button
        variant="ghost"
        size="sm"
        onClick={onClearSelection}
        disabled={disabled || isExecuting}
        className="ml-auto max-md:sticky max-md:right-0 max-md:bg-card"
      >
        <X className="size-3" />
        <span className="sr-only">Clear selection</span>
      </Button>
    </LayoutRow>
  );
}
