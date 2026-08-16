import type { Row } from "@tanstack/react-table";
import type { ReactNode } from "react";

/** Result of a bulk action execution */
interface BulkActionResult {
  success: boolean;
}

/** Configuration for a single bulk action */
export interface BulkAction<TData> {
  /** Unique identifier for this action */
  id: string;
  /** Display label */
  label: string;
  /** Icon component to display */
  icon?: ReactNode;
  /**
   * Renders destructive. Replaces the old `id === "delete"` convention in
   * `BulkActionBar`, which quietly assumed one destructive action existed and
   * that it was always minted by `useOptimisticDelete`.
   */
  tone?: "destructive";
  /** Minimum number of selected rows required (default: 1) */
  minSelection?: number;
  /** Maximum number of selected rows allowed (default: unlimited) */
  maxSelection?: number;
  /**
   * Keep the selection after a successful run, overriding the config-wide
   * `clearSelectionOnComplete`. For a read-only action (copy) the selection is
   * still what the user is working with once the action is done — dropping it
   * is what makes them re-tick every row to copy a second thing.
   */
  preserveSelection?: boolean;
  /** Execute the action on selected rows */
  onExecute: (selectedRows: Row<TData>[]) => Promise<BulkActionResult>;
}

/** Configuration for bulk actions on an entity list */
export interface BulkActionsConfig<TData> {
  /** Available actions */
  actions: BulkAction<TData>[];
  /** Whether to clear selection after action completes (default: true) */
  clearSelectionOnComplete?: boolean;
}
