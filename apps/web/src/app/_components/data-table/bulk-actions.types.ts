import type { Row } from "@tanstack/react-table";
import type { ReactNode } from "react";

/** Result of a bulk action execution */
export interface BulkActionResult {
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
  /** Whether this action requires confirmation */
  requiresConfirmation?: boolean;
  /** Custom confirmation dialog content (e.g., for merge showing target vs aliases) */
  renderConfirmation?: (rows: Row<TData>[]) => ReactNode;
  /** Minimum number of selected rows required (default: 1) */
  minSelection?: number;
  /** Maximum number of selected rows allowed (default: unlimited) */
  maxSelection?: number;
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
