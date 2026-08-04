import type { Entity } from "@cubby/schemas/entity";
import type { PreviewDeleteEntity } from "@cubby/schemas/entity-integrity";
import { relatedViewRegistry } from "@cubby/schemas/related-view";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { QueryKey } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import type { ColumnDef, ColumnHelper, Table } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
  summarizeListState,
} from "~/entities/filters";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import type { QueryTiming } from "~/lib/query-timing";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import type { RowLinkResolver } from "../data-table/columnHelpers";
import type { GroupConfig } from "../data-table/useGroupedList";
import { useTableColumnVisibility } from "../data-table/useTableColumnVisibility";
import { useTableConfig } from "../data-table/useTableConfig";
import {
  type TableStateReturn,
  useTableState,
} from "../data-table/useTableState";
import {
  type InfiniteScrollControls,
  useInfiniteTableList,
} from "./useInfiniteTableList";
import { ListBulkActionBar, useListBulkActions } from "./useListBulkActions";
import { useOptimisticDelete } from "./useOptimisticDelete";
import type { TRPCQueryOptionsFn } from "./usePaginatedTableCore";
import { useRelatedPreviewColumns } from "./useRelatedPreviewColumns";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

/** Base interface for entities in list views */
export interface BaseListRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData> = ColumnDef<TData, any>;

/** Stable empty-filters default (avoids a fresh `[]` reference each render). */
const NO_FILTERS: FilterInput[] = [];

/**
 * Expandable-tree rendering for a server-backed list.
 *
 * Presentation ONLY. The server still owns membership, ordering, totals, and
 * pagination — it just pages by tree ROOT instead of by row (see
 * repo/project/tree.ts), and `nest` reshapes the rows it returned into parents
 * and children. That's the whole difference from `useClientEntityList`'s
 * `ClientTreeConfig`, which nests rows the browser also filtered and paginated.
 *
 * Deliberately narrower than that config: `filterFromLeafRows` and
 * `paginateExpandedRows` are omitted because they're inert here — this table is
 * `manualFiltering`/`manualPagination`, so TanStack neither filters nor
 * paginates the rows they'd govern. Don't add them back by analogy.
 */
interface EntityListTreeConfig<TData, TRow> {
  /**
   * Nest the accumulated server rows before they reach the table. MUST be
   * referentially stable (module-level constant or `useMemo`d at the page).
   *
   * The input is the SERVER row and the output is the TABLE row; they differ
   * whenever a wish's candidate Products become child rows of a different
   * shape than their parent. They're the same type for a homogeneous tree
   * (sub-projects), which is why `TRow` defaults to `TData`.
   */
  nest: (rows: TRow[]) => TData[];
  /** Return a row's children — the presence of this is what wires expansion. */
  getSubRows: (row: TData) => TData[] | undefined;
  /** Render the expand/collapse chevron + depth indent on the name column. */
  expandable?: boolean;
  /**
   * Per-row detail link, when child rows are a DIFFERENT entity than the
   * parents (the wishlist nests candidate Products under a Wish). Threaded to
   * the name column and the actions menu together so they can't disagree.
   */
  rowLink?: RowLinkResolver<TData>;
  /**
   * Whether a row is an instance of the table's own `entity`. Required when
   * child rows are a foreign entity, and false for those children.
   *
   * Every mutation this hook wires — bulk delete, the row menu's Delete —
   * targets `entity`, so a foreign child handed to one goes to the wrong
   * endpoint under an id that entity never minted. Rather than trust each
   * caller to remember that twice, one predicate turns OFF both selection and
   * the row-action menu for those rows. Their own affordances live on their
   * own detail page, one click away through `rowLink`.
   */
  rowIsEntity?: (row: TData) => boolean;
}

export interface UseEntityListOptions<
  TData extends BaseListRow,
  TFilters,
  TRow extends BaseListRow = TData,
> {
  /** The entity type */
  entity: Entity;
  /** tRPC queryOptions function */
  queryOptions: TRPCQueryOptionsFn<TFilters>;
  /**
   * Build filters from table state. Omit it to derive them from the entity's
   * filter manifest, which is what every list page should do — a hand-written
   * builder is for the leftovers a manifest spec can't express.
   */
  buildFilters?: (tableState: TableStateReturn) => TFilters;
  /**
   * Contextual scope imposed by the surrounding page (for example, expenses
   * belonging to the displayed purchase). Saved views and top-level presets
   * must use ordinary manifest-backed filter state instead. Merged over the
   * manifest-derived filters. MUST be referentially stable.
   */
  scopeFilters?: Partial<TFilters>;
  /** Custom columns (inserted between standard columns) - accepts any accessor type */
  columns: AnyColumnDef<TData>[];
  /** Fallback filter definitions for columns the manifest doesn't cover. */
  filters?: FilterInput[];
  /**
   * Option lists for manifest specs naming an `optionsKey` (project roster,
   * recipe tags). MUST be referentially stable.
   */
  filterOptions?: Record<string, FilterableComboboxItem[]>;
  /** For unit mappings - function to extract mappings from each row (must be synchronous) */
  getMappings?: (item: TRow) => UnitMapping[];
  /** Override table state options (initialSort / initialFilter / …) */
  tableStateOptions?: Parameters<typeof useTableState>[0];
  /** Bulk actions configuration - automatically enables row selection */
  bulkActions?: BulkActionsConfig<TData>;
  /** Extra actions to render in the row action menu (after "View Details") */
  extraActions?: (row: TData) => ReactNode;
  /** Columns hidden by default (user can toggle via View menu) */
  initialColumnVisibility?: Record<string, boolean>;
  /** Separate persisted column set for an embedded table over this entity. */
  columnVisibilityScope?: string;
  /**
   * Width class for the standard name column. Defaults to auto (`min-w-0`),
   * which is right for dense tables. Pass a fixed width (e.g. `w-64`) on sparse
   * tables (few columns) so the name doesn't balloon under the fixed layout.
   */
  nameClassName?: string;
  /**
   * Enable inline editing on the standard name column (entities whose name
   * column is hook-prepended, e.g. products/recipes). MUST be referentially
   * stable — wrap in useMemo/useCallback at the page, or the columns memo
   * churns every render.
   */
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
  };
  /** Extra content rendered inline after the standard name column's name. */
  nameSuffix?: (row: TData) => ReactNode;
  /** Leading content on the name cell — see `createNameColumn`'s `namePrefix`. */
  namePrefix?: (row: TData) => ReactNode;
  /**
   * Column ids to render with no filter control — for a page that pins that
   * column's value via `scopeFilters` (which wins over the manifest-derived
   * filters), so a header control would otherwise be interactive but inert.
   * See `useStandardColumns`' doc comment. May be a fresh array literal each
   * render — internally stabilized.
   */
  hiddenFilterColumns?: string[];
  /** Group configuration — enables group toggle and server-side group ordering */
  groupConfig?: GroupConfig<TData>;
  /** Render the list as an expandable tree — see {@link EntityListTreeConfig}. */
  tree?: EntityListTreeConfig<TData, TRow>;
  /** Enable delete functionality - adds row menu item, bulk action, and dialog */
  deletable?: {
    /** tRPC delete mutation options factory */
    mutationOptions: (callbacks: {
      onSuccess: () => void;
      onError: (err: { message?: string }) => void;
    }) => unknown;
    /** Entity type label for dialog (e.g., "Product", "Ingredient") */
    entityLabel: string;
    /** Query keys to invalidate on success */
    invalidateKeys: readonly QueryKey[];
    /** Entity slug for the operation-impact preview fetched while the confirm dialog is open. */
    entity: PreviewDeleteEntity;
  };
}

export interface UseEntityListReturn<TData, TFilters = unknown, TRow = TData> {
  /** Configured table instance */
  table: Table<TData>;
  /**
   * The filter object the list query is running with (manifest-derived state
   * plus `scopeFilters`). For a page that must call a second procedure over
   * the SAME filtered set — the expenses ledger's totals row — so it can't
   * drift from the table's own.
   */
  currentFilters: TFilters;
  /** Loaded unit mappings map (id -> mappings) */
  mappingsMap: Record<string, UnitMapping[]>;
  /**
   * Raw data array (for edge cases like card view). Always FLAT — in tree mode
   * this is every loaded row, parents and children alike, not the nested shape
   * the table renders.
   */
  data: TRow[];
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Query timing info */
  timing: QueryTiming;
  /** Bulk action bar element to render in RTable (null if no bulk actions configured) */
  bulkActionBar: ReactNode | null;
  /** Delete dialog element - render in component if deletable is enabled */
  deleteDialog: ReactNode | null;
  /** Opens the delete confirmation for one item (e.g. mobile swipe actions) */
  requestDelete: (item: TData) => void;
  /** Infinite scroll controls for the server-backed list. */
  infiniteScroll: InfiniteScrollControls;
  /** Pull-to-refresh controls for mobile views */
  refreshControls: {
    onRefresh: () => Promise<void>;
    isRefreshing: boolean;
  };
  /** Whether grouping is currently active */
  grouped: boolean;
  /** Toggle grouping on/off */
  onGroupedChange: (value: boolean) => void;
  /** Group config (passed through for Table.tsx) */
  groupConfig?: GroupConfig<TData>;
  /**
   * The true server-side filtered total — in infinite mode this is the
   * server total, NOT the number of rows loaded/accumulated so far (`data.length`).
   * `undefined` while the first page is loading (the underlying query hooks
   * default totalCount to 0 pre-response, which would otherwise flash "0 …"
   * in the eyebrow). Feed straight to `usePageCount` for the eyebrow record
   * count.
   */
  totalCount: number | undefined;
}

/**
 * Hook for managing entity list pages with common conventions.
 *
 * Handles:
 * - Infinite table query via useInfiniteTableList
 * - Unit mappings loading if getMappings provided
 * - Standard identity columns from entity config plus shared audit dates
 * - Filter expansion from simple string definitions
 */
export function useEntityList<
  TData extends BaseListRow,
  TFilters,
  TRow extends BaseListRow = TData,
>({
  entity,
  queryOptions,
  buildFilters,
  scopeFilters,
  columns: customColumns,
  filters,
  filterOptions,
  getMappings,
  tableStateOptions,
  bulkActions,
  extraActions,
  deletable,
  initialColumnVisibility,
  columnVisibilityScope,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  hiddenFilterColumns,
  groupConfig,
  tree,
}: UseEntityListOptions<TData, TFilters, TRow>): UseEntityListReturn<
  TData,
  TFilters,
  TRow
> {
  const [grouped, setGrouped] = useState(false);

  const onGroupedChange = useCallback((value: boolean) => {
    setGrouped(value);
  }, []);

  // Derive the groupBy field for server queries (only when grouped + groupConfig)
  const groupByField = grouped && groupConfig ? groupConfig.field : undefined;

  // Create columnHelper once - CRITICAL to prevent infinite re-renders
  const columnHelper = useMemo(
    () => createColumnHelper<TData>() as ColumnHelper<TData>,
    [],
  );

  // Optimistic delete: mutation, bulk action, extra actions, dialog
  const {
    deleteBulkAction,
    combinedExtraActions,
    deleteDialog,
    requestDelete,
  } = useOptimisticDelete<TData>({ deletable, extraActions });

  const listBulkActions = useListBulkActions({
    bulkActions,
    deleteBulkAction,
  });

  // Memoize entity config to prevent re-renders when entity doesn't change
  const { hasUnitMappings, defaultSort } = useMemo(() => {
    const entityConfig = entities[entity];
    const listConfig = entityConfig.list;
    return {
      hasUnitMappings: listConfig?.hasUnitMappings ?? false,
      defaultSort: listConfig?.defaultSort ?? "createdAt",
    };
  }, [entity]);

  // Memoize table state options to prevent recreating on every render
  const mergedTableStateOptions = useMemo(
    () => ({
      initialSort: defaultSort,
      // Mirror sort + pagination + filters to the URL (bookmarkable /
      // shareable). Overridable: `useTableState` wants exactly ONE writer per
      // page, so a table embedded alongside others must opt out.
      urlSync: true,
      syncPaginationToUrl: false,
      filterSpecs: getEntityFilters(entity),
      ...tableStateOptions,
    }),
    [defaultSort, entity, tableStateOptions],
  );

  // One tableState owns the server-backed list. Infinite lists still use page
  // size internally, but never expose meaningless page/pageSize URL state.
  const tableState = useTableState(mergedTableStateOptions);

  // Tab title: `Products: packout ↓price | cubby`, so several list tabs of the
  // same entity are tellable apart.
  //
  // Summarized HERE rather than in the route's `head` on purpose. `head` runs in
  // the route module, which is part of TanStack Router's eager graph — importing
  // the icon/options-bearing filter manifest there is exactly the hydration
  // weight `filter-search-fields` was extracted to avoid. This hook already has
  // the manifest loaded (the table needs it), so the summary is free here, and
  // it can use the real option labels ("Last 30 days", not the raw `30d`).
  //
  // Gated on `urlSync` because that already marks the ONE list that owns the
  // page's URL state; an embedded table (the project detail page's tasks and
  // expenses) opts out of it and must not retitle the page either.
  const search = useSearch({ strict: false });
  useDocumentTitle(
    mergedTableStateOptions.urlSync
      ? [
          entities[entity].pluralLabel,
          summarizeListState(getEntityFilters(entity), search),
        ]
          .filter(Boolean)
          .join(": ")
      : undefined,
  );

  // Column-filter state → the server's `*Filters` object, driven by the
  // entity's manifest. This replaced a hand-written `buildFilters` on every
  // list page, all of which were the same mechanical column-id → field map.
  // A page may still pass its own for anything a spec can't express.
  const manifestBuildFilters = useCallback(
    (ts: TableStateReturn) =>
      ({
        ...buildFiltersFromManifest(
          getEntityFilters(entity),
          // `allFilters`, not `columnFilters` — a URL-only scope (`?productId=`)
          // never enters the table's state, but still has to reach the server.
          // Reads raw state rather than `getColumnFilter`, which deliberately
          // throws on an array — the builder is the one caller that handles
          // both shapes, per each spec's `kind`.
          filterGetterFromColumnFilters(ts.allFilters),
        ),
        ...scopeFilters,
      }) as TFilters,
    [entity, scopeFilters],
  );

  const effectiveBuildFilters = buildFilters ?? manifestBuildFilters;

  // The exact filter object the list query runs with. Returned so a page
  // needing the same set (the expenses ledger's totals row calls
  // `expense.analytics` with it) reads it rather than rebuilding it from
  // table state — two builds that disagree by so much as a scalar-vs-array
  // shape open a second React Query cache entry for identical results.
  const currentFilters = useMemo(
    () => effectiveBuildFilters(tableState),
    [effectiveBuildFilters, tableState],
  );

  // Selection belongs to a filtered result set. Keeping ids selected after
  // the filter scope changes makes the toolbar count disagree with the rows it
  // can actually act on. Sorting alone deliberately does not clear selection.
  const filterScopeKey = useMemo(
    () => JSON.stringify(currentFilters),
    [currentFilters],
  );
  const previousFilterScopeKeyRef = useRef(filterScopeKey);
  useEffect(() => {
    if (previousFilterScopeKeyRef.current === filterScopeKey) return;
    previousFilterScopeKeyRef.current = filterScopeKey;
    listBulkActions.state.clearSelection();
  }, [filterScopeKey, listBulkActions.state.clearSelection]);

  const infiniteResult = useInfiniteTableList<TFilters, TRow>({
    queryOptions,
    buildFilters: effectiveBuildFilters,
    tableState,
    groupBy: groupByField,
  });

  const { data, totalCount, sums, isLoading, error, timing, refreshControls } =
    infiniteResult;

  const relatedViews = useMemo(
    () => relatedViewRegistry.filter((view) => view.source === entity),
    [entity],
  );
  const relatedInitialVisibility = useMemo(
    () =>
      Object.fromEntries(
        relatedViews.map((view) => [
          `related:${view.key}`,
          view.defaultVisible,
        ]),
      ),
    [relatedViews],
  );
  const mergedInitialColumnVisibility = useMemo(
    () => ({
      createdAt: false,
      updatedAt: false,
      ...relatedInitialVisibility,
      ...initialColumnVisibility,
    }),
    [initialColumnVisibility, relatedInitialVisibility],
  );
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility(
      entity,
      mergedInitialColumnVisibility,
      columnVisibilityScope,
    );
  const visibleRelatedKeys = useMemo(
    () =>
      relatedViews
        .filter((view) => columnVisibility[`related:${view.key}`] !== false)
        .map((view) => view.key),
    [columnVisibility, relatedViews],
  );
  const sourceIds = useMemo(() => data.map((item) => item.id), [data]);
  const { relatedColumns, rowContentVersion } = useRelatedPreviewColumns({
    entity,
    sourceIds,
    visibleRelationKeys: visibleRelatedKeys,
    relatedViews,
    columnHelper,
    filterOptions,
    supportsServerSorting: true,
  });

  // Full-filtered-set totals for footer renderers — client rows only cover
  // the loaded pages, so footers must not sum/count them.
  const serverTotals = useMemo(
    () => ({ totalCount, sums }),
    [totalCount, sums],
  );

  // Load unit mappings synchronously if getMappings is provided
  const mappingsMap = useMemo(() => {
    if (!getMappings || !hasUnitMappings) return {};

    return Object.fromEntries(
      data.map((item) => [item.id, getMappings(item)] as const),
    );
  }, [data, getMappings, hasUnitMappings]);

  // Track mappings only when they're actually used to avoid re-renders from useMemo returning new {} references
  const shouldUseMappings = hasUnitMappings && getMappings;
  const effectiveMappingsMap = shouldUseMappings ? mappingsMap : null;

  const combinedCustomColumns = useMemo(
    () => [...customColumns, ...relatedColumns],
    [customColumns, relatedColumns],
  );

  // A foreign child row gets no row-action menu and no checkbox: both act
  // through `entity`'s mutations, which don't know that id. See
  // `EntityListTreeConfig.rowIsEntity`.
  const rowActionsGuard = tree?.rowIsEntity;
  const guardedExtraActions = useMemo(() => {
    if (!rowActionsGuard) return combinedExtraActions;
    return (row: TData) =>
      rowActionsGuard(row) ? combinedExtraActions?.(row) : null;
  }, [combinedExtraActions, rowActionsGuard]);

  const allColumns = useStandardColumns<TData>({
    entity,
    columnHelper,
    customColumns: combinedCustomColumns,
    filters: filters ?? NO_FILTERS,
    filterOptions,
    enableRowSelection: listBulkActions.enableRowSelection,
    combinedExtraActions: guardedExtraActions,
    mappingsMap: effectiveMappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
    nameSuffix,
    namePrefix,
    hiddenFilterColumns,
    expandable: tree?.expandable,
    rowLink: tree?.rowLink,
  });

  // Row identity is independent of whether selection happens to be enabled.
  // Index ids transfer virtualizer measurements and row state to the wrong
  // entity when filters, sorting, or accumulated pages change.
  const getRowId = useCallback((row: TData) => row.id, []);

  // Column widths are NOT wired here — `RTable` owns them, keyed off its
  // `entity`/`sizingKey` prop, so a hand-wired table can't miss out.

  // Tree mode nests the accumulated rows; every other consumer above — the
  // related-preview `sourceIds`, `mappingsMap`, the select-all-matching count —
  // deliberately keeps reading the FLAT `data`, which already contains every
  // row including nested ones.
  //
  // The cast covers only the NO-tree branch, where the table renders the
  // server rows as-is: `TRow` defaults to `TData`, so the two are the same
  // type there and nothing is being reinterpreted. Only `nest` may return a
  // different row shape, and it is typed to do so.
  const tableData = useMemo(
    () => (tree ? tree.nest(data) : (data as unknown as TData[])),
    [data, tree],
  );

  // Feed all accumulated rows as a single "page" so TanStack Table doesn't
  // try to paginate the infinite result.
  const table = useTableConfig({
    data: tableData,
    columns: allColumns,
    tableState,
    totalCount: tableData.length,
    manualPagination: true,
    ...(tree
      ? {
          getSubRows: tree.getSubRows,
          // Rows churn on every infinite-scroll page and on every mutation
          // refetch; TanStack's default would collapse the user's expanded
          // rows each time.
          autoResetExpanded: false,
        }
      : {}),
    getRowId,
    enableRowSelection: rowActionsGuard
      ? (row) =>
          listBulkActions.enableRowSelection && rowActionsGuard(row.original)
      : listBulkActions.enableRowSelection,
    rowSelection: listBulkActions.rowSelection,
    onRowSelectionChange: listBulkActions.onRowSelectionChange,
    initialColumnVisibility: mergedInitialColumnVisibility,
    columnVisibility,
    onColumnVisibilityChange,
    serverTotals,
    rowContentVersion,
  });

  // "Select all N matching": pull every remaining page into memory (bulk
  // actions need full rows, not ids), then select all.
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const handleSelectAllMatching = useCallback(async () => {
    setIsSelectingAll(true);
    try {
      // Select from the RETURNED items, not table.getRowModel(): the table
      // still holds the pre-load rows until React re-renders, so a
      // toggleAllRowsSelected here would only select the previously-loaded set.
      const allRows = await infiniteResult.infiniteScroll.loadAllPages();
      table.setRowSelection(
        Object.fromEntries(allRows.map((row) => [row.id, true])),
      );
      // loadAllPages is bounded (its safety cap); if the filtered set is
      // larger, surface that the selection is partial rather than letting a
      // bulk action silently miss rows.
      if (allRows.length < totalCount) {
        toast.warning(
          `Selected the first ${allRows.length.toLocaleString()} of ${totalCount.toLocaleString()} — too many to select at once. Narrow the filters to cover the rest.`,
        );
      }
    } finally {
      setIsSelectingAll(false);
    }
  }, [infiniteResult.infiniteScroll, table, totalCount]);

  // Build bulk action bar element if bulk actions configured.
  // In tree mode the two counts below measure different things — `data.length`
  // is loaded ROWS, `totalCount` is matching ROOTS — so the "select all N
  // matching" offer simply never fires. That's the honest outcome: it would
  // otherwise promise a count the selection can't match.
  const bulkActionBar = listBulkActions.config ? (
    <ListBulkActionBar
      table={table}
      config={listBulkActions.config}
      state={listBulkActions.state}
      selectAllMatching={{
        totalCount,
        loadedCount: data.length,
        onSelectAll: handleSelectAllMatching,
        isSelectingAll,
      }}
      disabled={infiniteResult.infiniteScroll.isTransitioning}
    />
  ) : null;

  return {
    table,
    currentFilters,
    mappingsMap,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    requestDelete,
    infiniteScroll: infiniteResult.infiniteScroll,
    refreshControls,
    grouped,
    onGroupedChange,
    groupConfig,
    // Withhold until the first response lands — the underlying query hooks
    // default totalCount to 0 pre-response, which would otherwise flash
    // "0 …" in the eyebrow before the real count arrives.
    totalCount: isLoading ? undefined : totalCount,
  };
}
