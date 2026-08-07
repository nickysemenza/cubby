import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import type { Row, Table } from "@tanstack/react-table";
import { ClipboardCopy } from "lucide-react";
import { useMemo } from "react";
import { copyShortcodes } from "~/lib/clipboard";
import {
  BulkActionBar,
  type BulkActionBarProps,
} from "../data-table/BulkActionBar";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import {
  type UseBulkActionsReturn,
  useBulkActions,
} from "../data-table/useBulkActions";

/**
 * "Copy shortcodes" for every shortcode-bearing entity list.
 *
 * Generic because a list row's `id` IS its public shortcode (see
 * `nameColumnParams` in columnHelpers.tsx, which builds every detail link as
 * `{ shortcode: String(row.id) }`). `image` is the one entity whose id stays a
 * uuid, so it's gated out by the `shortcodeEntities` roster rather than by a
 * second hand-kept list.
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
    return {
      id: "copy-shortcodes",
      label: "Copy codes",
      icon: <ClipboardCopy className="size-3.5" />,
      preserveSelection: true,
      onExecute: async (rows) => ({
        success: await copyShortcodes(rows.map((row) => row.original.id)),
      }),
    };
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

export function ListBulkActionBar<TData>({
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
