import { relatedViewRegistry } from "@cubby/schemas/related-view";
import type { ColumnHelper } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { useTableColumnVisibility } from "../data-table/useTableColumnVisibility";
import { useTableConfig } from "../data-table/useTableConfig";
import { useTableState } from "../data-table/useTableState";
import type {
  BaseListRow,
  UseEntityListOptions,
  UseEntityListReturn,
} from "./useEntityList";
import { ListBulkActionBar, useListBulkActions } from "./useListBulkActions";
import { useOptimisticDelete } from "./useOptimisticDelete";
import { useRelatedPreviewColumns } from "./useRelatedPreviewColumns";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

/** Stable empty-filters default (avoids a fresh `[]` reference each render). */
const NO_FILTERS: FilterInput[] = [];

/** Client-side pageSize default — smaller than the server list default (100). */
const DEFAULT_CLIENT_PAGE_SIZE = 25;

interface ClientTreeConfig<TData extends BaseListRow> {
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
  | "extraActions"
  | "nameEditable"
  | "nameSuffix"
  | "tableStateOptions"
  | "initialColumnVisibility"
  | "columnVisibilityScope"
  | "deleteEmptyLabel"
  | "hiddenFilterColumns"
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
  hiddenFilterColumns,
  deletable,
  extraActions,
  nameEditable,
  nameSuffix,
  tableStateOptions,
  initialColumnVisibility,
  columnVisibilityScope,
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
  } = useOptimisticDelete<TData>({
    deletable,
    extraActions,
    emptyLabel: deleteEmptyLabel,
  });

  const listBulkActions = useListBulkActions({
    entity,
    bulkActions,
    deleteBulkAction,
  });

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

  const filterScopeKey = useMemo(
    () => JSON.stringify(tableState.allFilters),
    [tableState.allFilters],
  );
  const previousFilterScopeKeyRef = useRef(filterScopeKey);
  useEffect(() => {
    if (previousFilterScopeKeyRef.current === filterScopeKey) return;
    previousFilterScopeKeyRef.current = filterScopeKey;
    listBulkActions.state.clearSelection();
  }, [filterScopeKey, listBulkActions.state.clearSelection]);

  const relatedViews = useMemo(
    () => relatedViewRegistry.filter((view) => view.source === entity),
    [entity],
  );
  const relatedInitialVisibility = useMemo(
    () =>
      ({
        createdAt: false,
        updatedAt: false,
        ...Object.fromEntries(
          relatedViews.map((view) => [
            `related:${view.key}`,
            view.defaultVisible,
          ]),
        ),
        ...initialColumnVisibility,
      }) as Record<string, boolean>,
    [relatedViews, initialColumnVisibility],
  );
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility(
      entity,
      relatedInitialVisibility,
      columnVisibilityScope,
    );
  const visibleRelatedKeys = useMemo(
    () =>
      relatedViews
        .filter((view) => columnVisibility[`related:${view.key}`] !== false)
        .map((view) => view.key),
    [columnVisibility, relatedViews],
  );
  const sourceIds = useMemo(() => {
    const ids: string[] = [];
    const visit = (rows: TData[]) => {
      for (const item of rows) {
        ids.push(item.id);
        const children = (item as TData & { subRows?: TData[] }).subRows;
        if (children) visit(children);
      }
    };
    visit(data);
    return ids;
  }, [data]);
  const { relatedColumns, rowContentVersion } = useRelatedPreviewColumns({
    entity,
    sourceIds,
    visibleRelationKeys: visibleRelatedKeys,
    relatedViews,
    columnHelper,
    supportsServerSorting: false,
  });
  const combinedCustomColumns = useMemo(
    () => [...customColumns, ...relatedColumns],
    [customColumns, relatedColumns],
  );

  // Standard columns (name link/inline-edit/nameSuffix + actions column with
  // delete). No unit mappings in the client variant.
  const allColumns = useStandardColumns<TData>({
    entity,
    columnHelper,
    customColumns: combinedCustomColumns,
    filters: filters ?? NO_FILTERS,
    hiddenFilterColumns,
    enableRowSelection: listBulkActions.enableRowSelection,
    combinedExtraActions,
    mappingsMap: null,
    hasUnitMappings: false,
    nameEditable,
    nameSuffix,
    expandable: tree?.expandable,
  });

  const getRowId = useCallback((row: TData) => row.id, []);

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
    enableRowSelection: listBulkActions.enableRowSelection,
    rowSelection: listBulkActions.rowSelection,
    onRowSelectionChange: listBulkActions.onRowSelectionChange,
    columnVisibility,
    onColumnVisibilityChange,
    initialColumnVisibility: relatedInitialVisibility,
    getSubRows: tree?.getSubRows,
    filterFromLeafRows: tree?.filterFromLeafRows,
    paginateExpandedRows: tree?.paginateExpandedRows,
    autoResetExpanded: tree?.autoResetExpanded,
    rowContentVersion,
  });

  const bulkActionBar = listBulkActions.config ? (
    <ListBulkActionBar
      table={table}
      config={listBulkActions.config}
      state={listBulkActions.state}
    />
  ) : null;

  return {
    table,
    bulkActionBar,
    deleteDialog,
    requestDelete,
  };
}
