import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { QueryTiming } from "~/lib/query-timing";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import RTable, { type RTableProps } from "./Table";
import type { CubbyTable } from "./table-features";
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
export interface ServerListWorkbenchModel<TItem extends RowData>
  extends ListWorkbenchModel<TItem> {
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
  | "currentRowId"
  | "defaultDensity"
  | "desktopInspector"
  | "onRowClick"
  | "onRowHover"
  | "onRowHoverEnd"
  | "showCellSelectionStats"
  | "showColumnMenu"
  | "verticalAlign"
>;

export interface ListWorkbenchProps<TItem extends RowData>
  extends CallerOwnedProps<TItem> {
  model: ListWorkbenchModel<TItem>;
  /** Page lists own the page workbench; relationship ledgers use compact chrome. */
  mode?: "page" | "embedded";
  /** Domain status or summary shown beside the shared table controls. */
  contextualStatus?: ReactNode;
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
        isLoading={model.isLoading}
        error={model.error}
        timing={model.timing}
        bulkActionBar={model.bulkActionBar}
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
