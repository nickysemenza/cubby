import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { CubbyRow as Row } from "./table-features";

/** Result of a bulk action execution */
export interface BulkActionResult {
  success: boolean;
}

/** Whether an action can run against the complete current selection. */
export type BulkActionAvailability =
  | { status: "available" }
  | { status: "disabled"; reason: string }
  | { status: "hidden" };

/** Configuration for a single bulk action */
export interface BulkAction<TData extends RowData> {
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
  /**
   * Resolve visibility and eligibility against the complete selected row set.
   * A disabled action stays visible with its reason; callers must never narrow
   * the rows to an eligible subset before execution.
   */
  availability?: (selectedRows: Row<TData>[]) => BulkActionAvailability;
  /** Execute the action on selected rows */
  onExecute: (selectedRows: Row<TData>[]) => Promise<BulkActionResult>;
}

export function resolveBulkActionAvailability<TData extends RowData>(
  action: BulkAction<TData>,
  selectedRows: Row<TData>[],
): BulkActionAvailability {
  return action.availability?.(selectedRows) ?? { status: "available" };
}

/** A bulk verb as the at-rest `Actions ▾` menu lists it. */
export type BulkActionPreview = Pick<
  BulkAction<RowData>,
  "id" | "label" | "icon"
>;

/** The at-rest menu entries for a list's bulk actions. */
export const bulkActionPreview = <TData extends RowData>(
  config: BulkActionsConfig<TData> | undefined,
): BulkActionPreview[] | undefined =>
  config?.actions.map(({ id, label, icon }) => ({ id, label, icon }));

/** Configuration for bulk actions on an entity list */
export interface BulkActionsConfig<TData extends RowData> {
  /** Available actions */
  actions: BulkAction<TData>[];
  /** Whether to clear selection after action completes (default: true) */
  clearSelectionOnComplete?: boolean;
}
