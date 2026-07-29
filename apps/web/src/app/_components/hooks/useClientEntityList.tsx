import type { ColumnHelper } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import { BulkActionBar } from "../data-table/BulkActionBar";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { useBulkActions } from "../data-table/useBulkActions";
import { useTableColumnSizing } from "../data-table/useTableColumnSizing";
import { useTableColumnVisibility } from "../data-table/useTableColumnVisibility";
import { useTableConfig } from "../data-table/useTableConfig";
import { useTableState } from "../data-table/useTableState";
import type {
  BaseListRow,
  UseEntityListOptions,
  UseEntityListReturn,
} from "./useEntityList";
import { useOptimisticDelete } from "./useOptimisticDelete";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

/** Stable empty-filters default (avoids a fresh `[]` reference each render). */
const NO_FILTERS: FilterInput[] = [];

/** Client-side pageSize default — smaller than the server list default (100). */
const DEFAULT_CLIENT_PAGE_SIZE = 25;

/** Expandable-tree configuration for the client list. */
interface ClientTreeConfig<TData extends BaseListRow> {
  /** Return a row's children — rows become `TData & { subRows: TData[] }`. */
  getSubRows: (row: TData) => TData[] | undefined;
  /** Keep a parent visible when a descendant leaf matches the filter. */
  filterFromLeafRows?: boolean;
  /** Paginate expanded sub-rows alongside parents. */
  paginateExpandedRows?: boolean;
  /** Reset expanded state when data/filters change. */
  autoResetExpanded?: boolean;
  /**
   * Render the expand/collapse chevron (+ depth indent) on the name column.
   * Flows through to `useStandardColumns` → `createNameColumn`. Pair with
   * `getSubRows` so the table actually wires `getExpandedRowModel`.
   */
  expandable?: boolean;
}

/**
 * The option fields `useClientEntityList` shares with `useEntityList`. Derived
 * from `UseEntityListOptions` (not re-declared) so the two hooks can't drift.
 * `TFilters` is irrelevant to the picked fields, hence `unknown`.
 */
type SharedListOptions<TData extends BaseListRow> = Pick<
  UseEntityListOptions<TData, unknown>,
  | "entity"
  | "columns"
  | "deletable"
  | "nameEditable"
  | "nameSuffix"
  | "tableStateOptions"
>;

interface UseClientEntityListOptions<TData extends BaseListRow>
  extends SharedListOptions<TData> {
  /** Caller-provided rows (already filtered/assembled). No query is run. */
  data: TData[];
  /** Filter definitions (optional; defaults to none). */
  filters?: FilterInput[];
  /** Opt-in expandable tree (TanStack getSubRows/getExpandedRowModel). */
  tree?: ClientTreeConfig<TData>;
  /**
   * Bulk actions configuration — combined with the delete bulk action (if
   * `deletable` is set), mirroring `useEntityList`'s `bulkActions`. Must be
   * referentially stable (wrap in `useMemo`) or the columns/table config churn
   * every render.
   */
  bulkActions?: BulkActionsConfig<TData>;
  /**
   * Names a row in the delete confirm dialog when its `name` is null/empty.
   * Pass the same function given to `createNameColumn`'s `emptyLabel` so the
   * dialog and the table agree — otherwise the dialog falls back to the raw
   * UUID, which tells the user nothing about what they're deleting.
   */
  deleteEmptyLabel?: (row: TData) => string;
}

/** Subset of `useEntityList`'s return relevant to the client-data variant. */
type UseClientEntityListReturn<TData> = Pick<
  UseEntityListReturn<TData>,
  "table" | "bulkActionBar" | "deleteDialog" | "requestDelete"
>;

/**
 * Client-data sibling of `useEntityList`: renders a caller-provided `TData[]`
 * with everything client-side (pagination / sorting / filtering) and optional
 * TanStack expansion, reusing the same leaf hooks (standard columns, optimistic
 * delete, bulk actions, column persistence).
 *
 * Differences from `useEntityList`: no query, no server totals, no infinite
 * scroll, no timing, no grouping, no refresh controls. `useOptimisticDelete`'s
 * cache-scrub is a no-op here (no list query cache to scrub) — invalidation on
 * the delete mutation still refreshes whatever query produced `data`.
 */
export function useClientEntityList<TData extends BaseListRow>({
  entity,
  data,
  columns: customColumns,
  filters,
  deletable,
  nameEditable,
  nameSuffix,
  tableStateOptions,
  tree,
  bulkActions,
  deleteEmptyLabel,
}: UseClientEntityListOptions<TData>): UseClientEntityListReturn<TData> {
  // Create columnHelper once — CRITICAL to prevent infinite re-renders.
  const columnHelper = useMemo(
    () => createColumnHelper<TData>() as ColumnHelper<TData>,
    [],
  );

  // Optimistic delete: mutation, bulk action, extra actions, dialog.
  const {
    deleteBulkAction,
    combinedExtraActions,
    deleteDialog,
    requestDelete,
  } = useOptimisticDelete<TData>({ deletable, emptyLabel: deleteEmptyLabel });

  // Combine the caller's bulk actions with the delete bulk action (if any) —
  // mirrors `useEntityList`'s equivalent merge.
  const effectiveBulkActions = useMemo(():
    | BulkActionsConfig<TData>
    | undefined => {
    if (!deleteBulkAction && !bulkActions) return undefined;

    const userActions = bulkActions?.actions ?? [];
    const combinedActions = deleteBulkAction
      ? [...userActions, deleteBulkAction]
      : userActions;

    return { ...bulkActions, actions: combinedActions };
  }, [deleteBulkAction, bulkActions]);

  // Always call useBulkActions unconditionally (Rules of Hooks).
  const EMPTY_BULK_CONFIG = useMemo(
    (): BulkActionsConfig<TData> => ({ actions: [] }),
    [],
  );
  const bulkActionsState = useBulkActions({
    config: effectiveBulkActions ?? EMPTY_BULK_CONFIG,
  });

  const effectiveEnableRowSelection = !!effectiveBulkActions;
  const effectiveRowSelection = effectiveBulkActions
    ? bulkActionsState.rowSelection
    : {};
  const effectiveOnRowSelectionChange = effectiveBulkActions
    ? bulkActionsState.onRowSelectionChange
    : undefined;

  // Entity default sort (mirrors useEntityList).
  const defaultSort = useMemo(
    () => entities[entity].list?.defaultSort ?? "createdAt",
    [entity],
  );

  const mergedTableStateOptions = useMemo(
    () => ({
      initialSort: defaultSort,
      initialPagination: { pageIndex: 0, pageSize: DEFAULT_CLIENT_PAGE_SIZE },
      // Mirror sort + pagination + filters to the URL (bookmarkable /
      // shareable). Overridable — one URL writer per page.
      urlSync: true,
      filterSpecs: getEntityFilters(entity),
      ...tableStateOptions,
    }),
    [defaultSort, entity, tableStateOptions],
  );

  const tableState = useTableState(mergedTableStateOptions);

  // Standard columns (name link/inline-edit/nameSuffix + actions column with
  // delete). No unit mappings in the client variant.
  const allColumns = useStandardColumns<TData>({
    entity,
    columnHelper,
    customColumns,
    filters: filters ?? NO_FILTERS,
    enableRowSelection: effectiveEnableRowSelection,
    combinedExtraActions,
    mappingsMap: null,
    hasUnitMappings: false,
    nameEditable,
    nameSuffix,
    expandable: tree?.expandable,
  });

  const getRowId = useMemo(
    () => (effectiveEnableRowSelection ? (row: TData) => row.id : undefined),
    [effectiveEnableRowSelection],
  );

  // Persisted per-entity column visibility + widths (same stores as useEntityList).
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility(entity);
  const { columnSizing, setColumnSize, resetColumnSize } =
    useTableColumnSizing(entity);

  // Client-side everything: manual* all false. Expansion wired only when a
  // tree config is provided (getSubRows presence gates getExpandedRowModel).
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount: data.length,
    manualPagination: false,
    manualSorting: false,
    manualFiltering: false,
    getRowId,
    enableRowSelection: effectiveEnableRowSelection,
    rowSelection: effectiveRowSelection,
    onRowSelectionChange: effectiveOnRowSelectionChange,
    columnVisibility,
    onColumnVisibilityChange,
    columnSizing,
    setColumnSize,
    resetColumnSize,
    getSubRows: tree?.getSubRows,
    filterFromLeafRows: tree?.filterFromLeafRows,
    paginateExpandedRows: tree?.paginateExpandedRows,
    autoResetExpanded: tree?.autoResetExpanded,
  });

  const bulkActionBar = useMemo(
    () =>
      effectiveBulkActions ? (
        <BulkActionBar
          selectedCount={bulkActionsState.selectedCount}
          selectedRows={table.getFilteredSelectedRowModel().rows}
          actions={bulkActionsState.getAvailableActions(
            table.getFilteredSelectedRowModel().rows,
          )}
          onExecute={bulkActionsState.executeAction}
          onClearSelection={bulkActionsState.clearSelection}
          isExecuting={bulkActionsState.isExecuting}
          currentAction={bulkActionsState.currentAction}
        />
      ) : null,
    [bulkActionsState, effectiveBulkActions, table],
  );

  return {
    table,
    bulkActionBar,
    deleteDialog,
    requestDelete,
  };
}
