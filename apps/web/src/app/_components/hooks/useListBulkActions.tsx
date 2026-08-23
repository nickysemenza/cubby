import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { useMemo } from "react";
import { copyShortcodes } from "~/lib/clipboard";
import { verbBulkAction } from "../actions/action-verb-ui";
import {
  BulkActionBar,
  type BulkActionBarProps,
} from "../data-table/BulkActionBar";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import type {
  CubbyRow as Row,
  CubbyTable as Table,
} from "../data-table/table-features";
import {
  type UseBulkActionsReturn,
  useBulkActions,
} from "../data-table/useBulkActions";

/**
 * "Copy shortcodes" for every shortcode-bearing entity list.
 *
 * Generic because a list row's `id` IS its public shortcode (see
 * `nameColumnParams` in columnHelpers.tsx, which builds every detail link as
 * `{ shortcode: String(row.id) }`). Gated on the `shortcodeEntities` roster
 * rather than a second hand-kept list — which is why `image` picked this action
 * up for free the moment it was given an `IMG-` code, and why `usda-food` (an
 * external `fdc_id`, no local table) still does not get it.
 *
 * Foreign child rows in a tree can't reach this: `EntityListTreeConfig.rowIsEntity`
 * already turns selection off for them, so their synthetic `parent:child` ids
 * never enter a selection.
 */
function useCopyShortcodesAction<TData extends { id: string }>(
  entity: Entity,
): BulkAction<TData> | null {
  return useMemo(() => {
    if (!(shortcodeEntities as readonly Entity[]).includes(entity)) return null;
    return verbBulkAction<TData>("copyCodes", {
      // The id predates the registry and is the one every list already ships.
      id: "copy-shortcodes",
      preserveSelection: true,
      onExecute: async (rows) => ({
        success: await copyShortcodes(rows.map((row) => row.original.id)),
      }),
    });
  }, [entity]);
}

export function useListBulkActions<TData extends { id: string }>({
  entity,
  bulkActions,
  deleteBulkAction,
}: {
  entity: Entity;
  bulkActions?: BulkActionsConfig<TData>;
  deleteBulkAction?: BulkAction<TData> | null;
}) {
  const copyAction = useCopyShortcodesAction<TData>(entity);

  const config = useMemo((): BulkActionsConfig<TData> | undefined => {
    if (!deleteBulkAction && !bulkActions && !copyAction) return undefined;
    return {
      ...bulkActions,
      // Copy leads and delete trails: the cheap, reversible action sits where
      // the pointer already is, the destructive one stays furthest from it.
      actions: [
        ...(copyAction ? [copyAction] : []),
        ...(bulkActions?.actions ?? []),
        ...(deleteBulkAction ? [deleteBulkAction] : []),
      ],
    };
  }, [bulkActions, copyAction, deleteBulkAction]);
  const emptyConfig = useMemo<BulkActionsConfig<TData>>(
    () => ({ actions: [] }),
    [],
  );
  const state = useBulkActions({ config: config ?? emptyConfig });

  return {
    config,
    state,
    enableRowSelection: config !== undefined,
    rowSelection: config ? state.rowSelection : {},
    onRowSelectionChange: config ? state.onRowSelectionChange : undefined,
  };
}

export function ListBulkActionBar<TData extends { id: string }>({
  table,
  config,
  state,
  selectAllMatching,
  disabled = false,
}: {
  table: Table<TData>;
  config?: BulkActionsConfig<TData>;
  state: UseBulkActionsReturn<TData>;
  selectAllMatching?: BulkActionBarProps<TData>["selectAllMatching"];
  disabled?: boolean;
}) {
  if (!config) return null;
  const selectedRows: Row<TData>[] = table.getFilteredSelectedRowModel().rows;
  return (
    <BulkActionBar
      selectedCount={state.selectedCount}
      selectedRows={selectedRows}
      actions={state.getAvailableActions(selectedRows)}
      onExecute={state.executeAction}
      onClearSelection={state.clearSelection}
      isExecuting={state.isExecuting}
      currentAction={state.currentAction}
      selectAllMatching={selectAllMatching}
      disabled={disabled}
    />
  );
}
