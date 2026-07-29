import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { QueryKey } from "@tanstack/react-query";
import type { ColumnDef, ColumnHelper, Table } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
} from "~/entities/filters";
import type { QueryTiming } from "~/lib/query-timing";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import type { GroupConfig } from "../data-table/useGroupedList";
import { useTableColumnSizing } from "../data-table/useTableColumnSizing";
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
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

/** Base interface for entities in list views */
export interface BaseListRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData> = ColumnDef<TData, any>;

/** Stable empty-filters default (avoids a fresh `[]` reference each render). */
const NO_FILTERS: FilterInput[] = [];

export interface UseEntityListOptions<TData extends BaseListRow, TFilters> {
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
   * Filters that aren't column filters: page-level scope constants and view
   * presets (a cookbook id, `topLevelOnly`, a mode's fixed `trade`). Merged
   * OVER the manifest-derived filters. MUST be referentially stable.
   */
  extraFilters?: Partial<TFilters>;
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
  getMappings?: (item: TData) => UnitMapping[];
  /** Override table state options (initialSort / initialFilter / …) */
  tableStateOptions?: Parameters<typeof useTableState>[0];
  /** Bulk actions configuration - automatically enables row selection */
  bulkActions?: BulkActionsConfig<TData>;
  /** Extra actions to render in the row action menu (after "View Details") */
  extraActions?: (row: TData) => ReactNode;
  /** Columns hidden by default (user can toggle via View menu) */
  initialColumnVisibility?: Record<string, boolean>;
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
  /**
   * Column ids to render with no filter control — for a page that pins that
   * column's value via `extraFilters` (which wins over the manifest-derived
   * filters), so a header control would otherwise be interactive but inert.
   * See `useStandardColumns`' doc comment. May be a fresh array literal each
   * render — internally stabilized.
   */
  hiddenFilterColumns?: string[];
  /** Group configuration — enables group toggle and server-side group ordering */
  groupConfig?: GroupConfig<TData>;
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
  };
}

export interface UseEntityListReturn<TData, TFilters = unknown> {
  /** Configured table instance */
  table: Table<TData>;
  /**
   * The filter object the list query is running with (manifest-derived state
   * plus `extraFilters`). For a page that must call a second procedure over
   * the SAME filtered set — the purchases ledger's totals row — so it can't
   * drift from the table's own.
   */
  currentFilters: TFilters;
  /** Loaded unit mappings map (id -> mappings) */
  mappingsMap: Record<string, UnitMapping[]>;
  /** Raw data array (for edge cases like card view) */
  data: TData[];
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
 * - Standard columns based on entity config (image, name, createdAt)
 * - Filter expansion from simple string definitions
 */
export function useEntityList<TData extends BaseListRow, TFilters>({
  entity,
  queryOptions,
  buildFilters,
  extraFilters,
  columns: customColumns,
  filters,
  filterOptions,
  getMappings,
  tableStateOptions,
  bulkActions,
  extraActions,
  deletable,
  initialColumnVisibility,
  nameClassName,
  nameEditable,
  nameSuffix,
  hiddenFilterColumns,
  groupConfig,
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<
  TData,
  TFilters
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
        ...extraFilters,
      }) as TFilters,
    [entity, extraFilters],
  );

  const effectiveBuildFilters = buildFilters ?? manifestBuildFilters;

  // The exact filter object the list query runs with. Returned so a page
  // needing the same set (the purchases ledger's totals row calls
  // `purchase.analytics` with it) reads it rather than rebuilding it from
  // table state — two builds that disagree by so much as a scalar-vs-array
  // shape open a second React Query cache entry for identical results.
  const currentFilters = useMemo(
    () => effectiveBuildFilters(tableState),
    [effectiveBuildFilters, tableState],
  );

  const infiniteResult = useInfiniteTableList<TFilters, TData>({
    queryOptions,
    buildFilters: effectiveBuildFilters,
    tableState,
    groupBy: groupByField,
  });

  const { data, totalCount, sums, isLoading, error, timing, refreshControls } =
    infiniteResult;

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

  // Build columns array with standard columns
  const allColumns = useStandardColumns<TData>({
    entity,
    columnHelper,
    customColumns,
    filters: filters ?? NO_FILTERS,
    filterOptions,
    enableRowSelection: listBulkActions.enableRowSelection,
    combinedExtraActions,
    mappingsMap: effectiveMappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
    nameSuffix,
    hiddenFilterColumns,
  });

  // Memoize getRowId to prevent recreating on every render
  const getRowId = useMemo(
    () =>
      listBulkActions.enableRowSelection ? (row: TData) => row.id : undefined,
    [listBulkActions.enableRowSelection],
  );

  // Persisted per-entity column visibility (localStorage), layered over the
  // page's initialColumnVisibility defaults.
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility(entity, initialColumnVisibility);

  // Persisted per-entity column widths (localStorage). Only user-resized
  // columns are stored; the rest keep their code-defined width classes.
  const { columnSizing, setColumnSize, resetColumnSize } =
    useTableColumnSizing(entity);

  // Feed all accumulated rows as a single "page" so TanStack Table doesn't
  // try to paginate the infinite result.
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount: data.length,
    manualPagination: false,
    getRowId,
    enableRowSelection: listBulkActions.enableRowSelection,
    rowSelection: listBulkActions.rowSelection,
    onRowSelectionChange: listBulkActions.onRowSelectionChange,
    initialColumnVisibility,
    columnVisibility,
    onColumnVisibilityChange,
    serverTotals,
    columnSizing,
    setColumnSize,
    resetColumnSize,
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

  // Build bulk action bar element if bulk actions configured
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
