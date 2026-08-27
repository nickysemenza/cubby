import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { useMemo, useRef } from "react";
import { copyShortcodes } from "~/lib/clipboard";
import { verbBulkAction } from "../actions/action-verb-ui";
import {
  type EntityActionsEntry,
  useEntityActions,
} from "../actions/entity-actions";
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

/**
 * A list with no registered actions must keep a stable `config`: the hook
 * rebuilds its arrays every render (each definition's `use()` is a hook), so
 * an empty result has to collapse to one module value or the memo below churns
 * on every render for every list in the app.
 */
const NO_REGISTERED_ACTIONS: readonly never[] = [];

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
  const registered = useEntityActions<TData>(entity);
  const registeredActions = registered.bulkActions.length
    ? registered.bulkActions
    : (NO_REGISTERED_ACTIONS as readonly BulkAction<TData>[]);

  const config = useMemo((): BulkActionsConfig<TData> | undefined => {
    if (
      !deleteBulkAction &&
      !bulkActions &&
      !copyAction &&
      registeredActions.length === 0
    )
      return undefined;
    return {
      ...bulkActions,
      // Copy leads and delete trails: the cheap, reversible action sits where
      // the pointer already is, the destructive one stays furthest from it.
      // Declared actions sit between the generic copy and the surface's own —
      // the entity-wide vocabulary before the local additions, matching the row
      // menu in `createActionsColumn`.
      actions: [
        ...(copyAction ? [copyAction] : []),
        ...registeredActions,
        ...(bulkActions?.actions ?? []),
        ...(deleteBulkAction ? [deleteBulkAction] : []),
      ],
    };
  }, [bulkActions, copyAction, deleteBulkAction, registeredActions]);
  const emptyConfig = useMemo<BulkActionsConfig<TData>>(
    () => ({ actions: [] }),
    [],
  );
  const state = useBulkActions({ config: config ?? emptyConfig });

  const rowMenuItems = registered.rowMenuItems;
  const latestRowMenuItems = useRef(rowMenuItems);
  latestRowMenuItems.current = rowMenuItems;
  const rowActions = useMemo<EntityActionsEntry>(
    () => ({
      entity,
      rowMenuItems: (row) => latestRowMenuItems.current(row),
    }),
    [entity],
  );
  // Stable for the component's life — `entity` is constant by
  // `useEntityActions`' own invariant, and reading the items through a ref
  // stops a fresh closure each render from invalidating the context for every
  // actions cell in the table.

  return {
    config,
    state,
    enableRowSelection: config !== undefined,
    rowSelection: config ? state.rowSelection : {},
    onRowSelectionChange: config ? state.onRowSelectionChange : undefined,
    /**
     * The registry half, from THIS hook's `useEntityActions` instance.
     *
     * It has to be the same instance the bar's actions came from: an action
     * stages its rows in the hook that owns its dialog, so resolving the bar
     * here and the dialogs somewhere else leaves every bulk action opening
     * nothing at all. Surfaces publish these rather than letting `RTable`
     * resolve its own — `RTable` only falls back when nobody does.
     */
    rowActions,
    actionDialogs: registered.dialogs,
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
