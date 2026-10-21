import type { RowData } from "@tanstack/react-table";
import { useCallback, useRef, useState } from "react";

import {
  bulkActionPreview,
  type BulkActionsConfig,
} from "~/ui/data-table/bulk-actions.types";
import { BulkActionBar } from "~/ui/data-table/bulk/bulk-action-bar";
import { useBulkActions } from "~/ui/data-table/use-bulk-actions";
import { useTableConfig } from "~/ui/data-table/use-table-config";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import type {
  ListQueryOptionsFn,
  ListQueryResponse,
} from "~/ui/hooks/use-paginated-table-core";

import { useInfiniteTableList } from "../hooks/use-infinite-table-list";
import type { ListWorkbenchModel } from "./list-workbench";
import type { TableStateReturn } from "./use-table-state";

type TableConfig<T extends RowData> = Parameters<typeof useTableConfig<T>>[0];
type ChildListOptions<
  F,
  T extends RowData & { id: string },
  P extends ListQueryResponse<T>,
> = Pick<
  TableConfig<T>,
  | "columns"
  | "initialColumnVisibility"
  | "scrollRestorationId"
  | "rowContentVersion"
> & {
  read: ListQueryOptionsFn<F, T, P>;
  filters: F;
  tableState: TableStateReturn;
  navigation: { kind: "none" };
  selection?: BulkActionsConfig<T>;
  serverTotals?: Omit<
    NonNullable<TableConfig<T>["serverTotals"]>,
    "totalCount"
  >;
};

const NO_ACTIONS = { actions: [] };
const NO_SELECTION = {};

/** Existing bounded child reads share the table lifecycle without acquiring CRUD or routes. */
export function useChildListWorkbench<
  F,
  T extends RowData & { id: string },
  P extends ListQueryResponse<T> = ListQueryResponse<T>,
>({
  read,
  filters,
  tableState,
  columns,
  navigation,
  selection: config,
  serverTotals,
  initialColumnVisibility,
  scrollRestorationId,
  rowContentVersion,
}: ChildListOptions<F, T, P>) {
  const buildFilters = useCallback(() => filters, [filters]);
  const list = useInfiniteTableList({
    queryOptions: read,
    buildFilters,
    tableState,
  });
  const isLoading = useHydratedLoading(list.isLoading);
  const transitioning = list.infiniteScroll.isTransitioning;
  const active = useRef({
    scope: list.scope,
    disabled: transitioning || isLoading,
  });
  if (active.current.scope !== list.scope) {
    active.current = {
      scope: list.scope,
      disabled: transitioning || isLoading,
    };
  } else {
    active.current.disabled = transitioning || isLoading;
  }
  // Identity also separates leaving and returning to the same query scope.
  const view = active.current;
  const scope = list.scope;
  const selection = useBulkActions<T>({
    config: config
      ? {
          ...config,
          actions: config.actions.map((action) => ({
            ...action,
            onExecute: async (rows) => {
              if (active.current !== view || active.current.disabled)
                return { success: false };
              const result = await action.onExecute(rows);
              // The same immutable row may be selected again under another scope.
              // A late completion owns only the submitting scope's selection.
              return active.current === view ? result : { success: false };
            },
          })),
        }
      : NO_ACTIONS,
  });
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    selection.clearSelection();
  }
  const canSelect = Boolean(config) && !active.current.disabled;
  const table = useTableConfig({
    data: list.data,
    columns,
    tableState,
    totalCount: list.totalCount,
    getRowId: (row) => row.id,
    enableRowSelection: canSelect,
    rowSelection: canSelect ? selection.rowSelection : NO_SELECTION,
    onRowSelectionChange: (updater) => {
      if (active.current === view && !active.current.disabled)
        selection.onRowSelectionChange(updater);
    },
    initialColumnVisibility,
    scrollRestorationId,
    rowContentVersion,
    serverTotals: transitioning
      ? undefined
      : { totalCount: list.totalCount, sums: serverTotals?.sums ?? list.sums },
  });
  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const model: ListWorkbenchModel<T> = {
    navigation,
    table,
    isLoading,
    error: list.error,
    timing: list.timing,
    infiniteScroll: list.infiniteScroll,
    refreshControls: list.refreshControls,
    bulkActionPreview: bulkActionPreview(config),
    bulkActionBar: config ? (
      <BulkActionBar
        selectedCount={canSelect ? selection.selectedCount : 0}
        selectedRows={selectedRows}
        actions={selection.getAvailableActions(selectedRows)}
        onExecute={selection.executeAction}
        onClearSelection={selection.clearSelection}
        isExecuting={selection.isExecuting}
        currentAction={selection.currentAction}
        disabled={!canSelect}
      />
    ) : null,
  };
  return { ...list, model };
}
