import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { RowData } from "@tanstack/react-table";

import { CurrencyValue } from "~/ui/common/currency-value";
import { Row as LayoutRow } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

import {
  type BulkAction,
  resolveBulkActionAvailability,
} from "../bulk-actions.types";
import type { CubbyRow as Row } from "../table-features";
import type { tableMoneyTotals } from "./table-money";

export interface BulkActionBarProps<TData extends RowData> {
  selectedCount: number;
  moneyTotals?: ReturnType<typeof tableMoneyTotals>;
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
  /** Eligibility is checked against resolved records before any action runs. */
  selectionIncomplete?: boolean;
}

/**
 * Toolbar component that appears when rows are selected.
 * Shows selection count, available actions, and a clear button.
 */
export function BulkActionBar<TData extends RowData>({
  selectedCount,
  selectedRows,
  moneyTotals,
  actions,
  onExecute,
  onClearSelection,
  isExecuting,
  currentAction,
  selectAllMatching,
  disabled = false,
  selectionIncomplete = false,
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
      (!selectionIncomplete &&
        resolveBulkActionAvailability(action, selectedRows).status !==
          "available")
    ) {
      return;
    }
    onExecute(action, selectedRows);
  };
  const orderedActions = actions
    .map((action) => ({
      action,
      availability: selectionIncomplete
        ? { status: "available" as const }
        : resolveBulkActionAvailability(action, selectedRows),
    }))
    .filter(({ availability }) => availability.status !== "hidden")
    .sort(
      (a, b) =>
        Number(a.action.tone === "destructive") -
        Number(b.action.tone === "destructive"),
    );

  return (
    <LayoutRow
      as="section"
      data-bulk-action-bar
      align="center"
      gap="md"
      wrap
      aria-label="Selected rows"
      aria-description={
        selectionIncomplete
          ? "Some selected records are unloaded. Actions load their required data and check the complete selection before running."
          : undefined
      }
      className="fixed bottom-[calc(var(--app-chrome-bottom,0px)+1rem)] left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 [scrollbar-width:none] flex-nowrap overflow-x-auto overscroll-x-contain rounded-lg bg-foreground py-1.5 pr-2 pl-3 text-background [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 text-sm tabular-nums">
        {selectedCount} selected
        {moneyTotals?.map((total) => (
          <span key={total.columnId}>
            {" "}
            · {moneyTotals.length > 1 ? `${total.label} ` : ""}
            <CurrencyValue
              value={total.value}
              interactive={false}
              tone={false}
            />
          </span>
        ))}
      </span>

      {showSelectAll && selectAllMatching && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7.5 border-background/15 bg-background/10 text-sm text-background hover:bg-background/20 hover:text-background"
          onClick={() => void selectAllMatching.onSelectAll()}
          disabled={disabled || isExecuting || selectAllMatching.isSelectingAll}
        >
          {selectAllMatching.isSelectingAll && (
            <Spinner className="mr-1 size-3" aria-hidden="true" />
          )}
          Select all {selectAllMatching.totalCount}
        </Button>
      )}

      {/* The horizontal rail accommodates each list's declared actions. */}
      <LayoutRow align="center" gap="md" className="flex-nowrap">
        {orderedActions.map(({ action, availability }) => {
          const disabledReason =
            availability.status === "disabled"
              ? availability.reason
              : undefined;
          return (
            <Button
              key={action.id}
              variant="outline"
              className="h-7.5 border-background/15 bg-background/10 text-sm text-background hover:bg-background/20 hover:text-background"
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
                <Spinner className="mr-1 size-3" aria-hidden="true" />
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
        className="sticky right-0 ml-auto size-7.5 shrink-0 bg-foreground p-0 text-background hover:bg-background/20 hover:text-background"
      >
        <XIcon className="size-3" />
        <span className="sr-only">Clear selection</span>
      </Button>
    </LayoutRow>
  );
}
