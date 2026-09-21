import type { Entity } from "@cubby/schemas/entity";
import { useMemo, useRef } from "react";

import { useRedundantOverrideBulkAction } from "~/entities/field-resolution";
import { generatedBrowserCrudEntities } from "~/entities/generated/entity-routes.gen";

import { verbBulkAction } from "../actions/action-verb-ui";
import {
  type EntityActionDefinition,
  type EntityActionsEntry,
  useEntityActions,
} from "../actions/entity-actions";
import type {
  BulkAction,
  BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import {
  BulkActionBar,
  type BulkActionBarProps,
} from "../data-table/BulkActionBar";
import type {
  CubbyRow as Row,
  CubbyTable as Table,
} from "../data-table/table-features";
import {
  type UseBulkActionsReturn,
  useBulkActions,
} from "../data-table/useBulkActions";

/**
 * A list with no registered actions must keep a stable `config`: the hook
 * rebuilds its arrays every render (each definition's `use()` is a hook), so
 * an empty result has to collapse to one module value or the memo below churns
 * on every render for every list in the app.
 */
const NO_ENTITY_ACTION_DEFINITIONS: readonly EntityActionDefinition[] = [];

function emptyBulkActions<TData extends { id: string }>(): BulkAction<TData>[] {
  return [];
}

export function useListBulkActions<TData extends { id: string }>({
  entity,
  bulkActions,
  deleteBulkAction,
  additionalActions,
  onInspectRow,
  includeCatalogActions = true,
  selectable = true,
}: {
  entity: Entity;
  bulkActions?: BulkActionsConfig<TData>;
  deleteBulkAction?: BulkAction<TData> | null;
  /** Surface-owned lifecycle definitions resolved by the same catalog. */
  additionalActions?: readonly EntityActionDefinition[];
  /** Presentation-only action for the one checked canonical record. */
  onInspectRow?: (row: Row<TData>) => void;
  /** Embedded specialist tables may keep their contextual action vocabulary. */
  includeCatalogActions?: boolean;
  /**
   * False removes checkbox selection and the bulk bar while keeping the row
   * `…` menu. `includeCatalogActions: false` is not this: it empties the
   * registry, so the row menu loses Edit/Copy/Delete with it.
   */
  selectable?: boolean;
}) {
  const inspectAction = useMemo<BulkAction<TData> | null>(
    () =>
      onInspectRow
        ? verbBulkAction<TData>("inspect", {
            maxSelection: 1,
            preserveSelection: true,
            onExecute: async (rows) => {
              const selected = rows[0];
              if (!selected) return { success: false };
              onInspectRow(selected);
              return { success: true };
            },
          })
        : null,
    [onInspectRow],
  );
  const registered = useEntityActions<TData>(
    entity,
    includeCatalogActions ? undefined : NO_ENTITY_ACTION_DEFINITIONS,
    additionalActions,
  );
  const registeredActions = registered.selectionActions.length
    ? registered.selectionActions
    : emptyBulkActions<TData>();
  const editableEntity = generatedBrowserCrudEntities.find(
    (candidate) => candidate === entity,
  );
  const redundantOverrideAction =
    useRedundantOverrideBulkAction<TData>(editableEntity);

  const config = useMemo((): BulkActionsConfig<TData> | undefined => {
    if (!selectable) return undefined;
    if (
      !deleteBulkAction &&
      !bulkActions &&
      !inspectAction &&
      !redundantOverrideAction &&
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
        ...(inspectAction ? [inspectAction] : []),
        ...registeredActions,
        ...(redundantOverrideAction ? [redundantOverrideAction] : []),
        ...(bulkActions?.actions ?? []),
        ...(deleteBulkAction ? [deleteBulkAction] : []),
      ],
    };
  }, [
    bulkActions,
    deleteBulkAction,
    inspectAction,
    registeredActions,
    redundantOverrideAction,
    selectable,
  ]);
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
