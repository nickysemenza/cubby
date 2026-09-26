import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { QueryTiming } from "~/lib/query-timing";

import type { EntityActionsEntry } from "../actions/entity-actions";
import type { UseEntitySelectionReturn } from "../hooks/useEntitySelection";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { useTableColumnLayout } from "./column-layout";
import RTable, { type RTableProps } from "./Table";
import { type CubbyTable, useCubbyTable } from "./table-features";
import type { GroupConfig } from "./useGroupedList";

/**
 * The complete rendering contract produced by the list hooks.
 *
 * Page and embedded callers should not coordinate query state, refresh,
 * grouping, bulk actions, and deletion chrome one prop at a time. The hooks
 * assemble that implementation detail once; ListWorkbench consumes it once.
 */
export interface ListWorkbenchModel<TItem extends RowData> {
  entity: Entity;
  table: CubbyTable<TItem>;
  isLoading?: boolean;
  error?: unknown;
  timing?: QueryTiming;
  bulkActionBar?: ReactNode;
  bulkActionPreview?: RTableProps<TItem>["bulkActionPreview"];
  /**
   * The entity each row is *about*, when different from `entity`. Publishing
   * it is what makes that entity's actions reachable from these rows.
   */
  subjectEntity?: Entity;
  /** Published so the bar's actions and their dialogs share one instance. */
  rowActions?: EntityActionsEntry;
  actionDialogs?: ReactNode;
  deleteDialog?: ReactNode;
  infiniteScroll?: InfiniteScrollControls;
  refreshControls?: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
  groupConfig?: GroupConfig<TItem>;
  grouped?: boolean;
  onGroupedChange?: (value: boolean) => void;
}

/** Server-backed lists always provide the complete asynchronous controls. */
export interface ServerListWorkbenchModel<
  TItem extends RowData,
> extends ListWorkbenchModel<TItem> {
  isLoading: boolean;
  error: Error | null;
  timing: QueryTiming;
  bulkActionBar: ReactNode | null;
  deleteDialog: ReactNode | null;
  infiniteScroll: InfiniteScrollControls;
  refreshControls: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
  grouped: boolean;
  onGroupedChange: (value: boolean) => void;
}

type CallerOwnedProps<TItem extends RowData> = Pick<
  RTableProps<TItem>,
  | "actions"
  | "ariaLabel"
  | "emptyState"
  | "filterOptionHints"
  | "getRowClassName"
  | "getMobileDetailsHref"
  | "disableMobileDetailsHref"
  | "renderMobileRowFooter"
  | "inspectorToggle"
  | "currentRowId"
  | "desktopInspector"
  | "onRowClick"
  | "onRowHover"
  | "onRowHoverEnd"
  | "showCellSelectionStats"
  | "showColumnMenu"
  | "verticalAlign"
  | "toolbarMode"
>;

export interface ListWorkbenchProps<
  TItem extends RowData,
> extends CallerOwnedProps<TItem> {
  model: ListWorkbenchModel<TItem>;
  /** Page lists own the page workbench; relationship ledgers use compact chrome. */
  mode?: "page" | "embedded";
  /** Domain status or summary shown beside the shared table controls. */
  contextualStatus?: ReactNode;
}

type CubbyTableOptions<TItem extends RowData> = Parameters<
  typeof useCubbyTable<TItem>
>[0];

type BoundedListWorkbenchOptions<TItem extends RowData & { id: string }> = Omit<
  CubbyTableOptions<TItem>,
  "data" | "columns" | "meta"
> & {
  entity: Entity;
  data: TItem[];
  columns: Parameters<typeof useTableColumnLayout<TItem>>[0]["columns"];
  initialColumnVisibility?: Parameters<
    typeof useTableColumnLayout<TItem>
  >[0]["initialColumnVisibility"];
  selection?: UseEntitySelectionReturn<TItem>;
  isLoading?: boolean;
  deleteDialog?: ReactNode;
};

/**
 * The complete bounded-table implementation: in-session column layout, table
 * construction, optional entity selection, bulk chrome, and dialogs are
 * wired once.
 */
export function useBoundedListWorkbench<
  TItem extends RowData & { id: string },
>({
  entity,
  data,
  columns,
  initialColumnVisibility,
  selection,
  isLoading,
  deleteDialog,
  ...tableOptions
}: BoundedListWorkbenchOptions<TItem>): ListWorkbenchModel<TItem> {
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
    initialColumnVisibility,
  });
  const table = useCubbyTable({
    ...tableOptions,
    data,
    columns: tableColumns,
    initialState: {
      ...tableOptions.initialState,
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
    enableRowSelection:
      selection?.enableRowSelection ?? tableOptions.enableRowSelection,
    state: selection
      ? { ...tableOptions.state, rowSelection: selection.rowSelection }
      : tableOptions.state,
    onRowSelectionChange:
      selection?.onRowSelectionChange ?? tableOptions.onRowSelectionChange,
  });
  return {
    entity,
    table,
    isLoading,
    bulkActionBar: selection?.renderBulkActionBar(table),
    ...selection?.tableProps,
    deleteDialog,
  };
}

/**
 * Render a list hook's complete workbench while leaving domain choices local:
 * columns are supplied to the hook; actions, contextual status, honest empty
 * copy, and deliberate row styling stay visible at this call site.
 */
export function ListWorkbench<TItem extends RowData>({
  model,
  mode = "page",
  contextualStatus,
  ...callerOwned
}: ListWorkbenchProps<TItem>) {
  const embedded = mode === "embedded";
  return (
    <>
      <RTable
        table={model.table}
        entity={model.entity}
        subjectEntity={model.subjectEntity}
        rowActions={model.rowActions}
        actionDialogs={model.actionDialogs}
        isLoading={model.isLoading}
        error={model.error}
        timing={model.timing}
        bulkActionBar={model.bulkActionBar}
        bulkActionPreview={model.bulkActionPreview}
        infiniteScroll={model.infiniteScroll}
        refreshControls={model.refreshControls}
        groupConfig={model.groupConfig}
        grouped={model.grouped}
        onGroupedChange={model.onGroupedChange}
        embedded={embedded}
        toolbarMode={embedded ? "internal" : "auto"}
        additionalToolbarContent={contextualStatus}
        {...callerOwned}
      />
      {model.deleteDialog}
    </>
  );
}
