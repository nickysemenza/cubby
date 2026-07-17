import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { QueryKey } from "@tanstack/react-query";
import type {
  ColumnDef,
  ColumnHelper,
  OnChangeFn,
  RowSelectionState,
  Table,
} from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { entities } from "~/entities/entities";
import type { QueryTiming } from "~/lib/query-timing";
import { BulkActionBar } from "../data-table/BulkActionBar";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { useBulkActions } from "../data-table/useBulkActions";
import type { GroupConfig } from "../data-table/useGroupedList";
import { useTableColumnVisibility } from "../data-table/useTableColumnVisibility";
import { useTableConfig } from "../data-table/useTableConfig";
import { useTableState } from "../data-table/useTableState";
import {
  type InfiniteScrollControls,
  useInfiniteTableList,
} from "./useInfiniteTableList";
import { useOptimisticDelete } from "./useOptimisticDelete";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";
import { type UseTableListOptions, useTableList } from "./useTableList";

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string;
  createdAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData> = ColumnDef<TData, any>;

interface UseEntityListOptions<TData extends BaseListRow, TFilters> {
  /** The entity type */
  entity: Entity;
  /** tRPC queryOptions function */
  queryOptions: UseTableListOptions<TFilters>["queryOptions"];
  /** Build filters from table state */
  buildFilters: UseTableListOptions<TFilters>["buildFilters"];
  /** Custom columns (inserted between standard columns) - accepts any accessor type */
  columns: AnyColumnDef<TData>[];
  /** Filter definitions - string shorthand or full FilterDef config */
  filters: FilterInput[];
  /** For unit mappings - function to extract mappings from each row (must be synchronous) */
  getMappings?: (item: TData) => UnitMapping[];
  /** Override table state options (initialSort / initialFilter / …) */
  tableStateOptions?: Parameters<typeof useTableState>[0];
  /** Global filter state (for custom global filters like IngredientList) */
  globalFilter?: unknown;
  /** Global filter change handler */
  onGlobalFilterChange?: (value: unknown) => void;
  /** Enable row selection with checkbox column (for manual row selection management) */
  enableRowSelection?: boolean;
  /** Current row selection state (required if enableRowSelection is true) */
  rowSelection?: RowSelectionState;
  /** Callback when row selection changes */
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  /** Bulk actions configuration - automatically enables row selection */
  bulkActions?: BulkActionsConfig<TData>;
  /** Extra actions to render in the row action menu (after "View Details") */
  extraActions?: (row: TData) => ReactNode;
  /** Enable infinite scroll on mobile (default: false) */
  infinite?: boolean;
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

interface UseEntityListReturn<TData> {
  /** Configured table instance */
  table: Table<TData>;
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
  /** Infinite scroll controls (only present when infinite: true) */
  infiniteScroll?: InfiniteScrollControls;
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
}

/**
 * Hook for managing entity list pages with common conventions.
 *
 * Handles:
 * - Table query via useTableList
 * - Unit mappings loading if getMappings provided
 * - Standard columns based on entity config (image, name, createdAt)
 * - Filter expansion from simple string definitions
 */
export function useEntityList<TData extends BaseListRow, TFilters>({
  entity,
  queryOptions,
  buildFilters,
  columns: customColumns,
  filters,
  getMappings,
  tableStateOptions,
  globalFilter,
  onGlobalFilterChange,
  enableRowSelection,
  rowSelection,
  onRowSelectionChange,
  bulkActions,
  extraActions,
  deletable,
  infinite = false,
  initialColumnVisibility,
  nameClassName,
  nameEditable,
  groupConfig,
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<TData> {
  const [grouped, setGrouped] = useState(false);

  // Server-backed infinite mode accumulates pages on both desktop and mobile.
  // The table still virtualizes the accumulated rows, so desktop does not need
  // the old sticky pager or a 500-row first page to feel continuous.
  const useInfiniteMode = infinite;

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

  // Combine user's bulk actions with delete bulk action if deletable is provided
  const effectiveBulkActions = useMemo(():
    | BulkActionsConfig<TData>
    | undefined => {
    if (!deleteBulkAction && !bulkActions) return undefined;

    const userActions = bulkActions?.actions ?? [];
    const combinedActions = deleteBulkAction
      ? [...userActions, deleteBulkAction]
      : userActions;

    return {
      ...bulkActions,
      actions: combinedActions,
    };
  }, [deleteBulkAction, bulkActions]);

  // Always call useBulkActions unconditionally (Rules of Hooks).
  // When no bulk actions configured, pass an empty config.
  const EMPTY_BULK_CONFIG = useMemo(
    (): BulkActionsConfig<TData> => ({ actions: [] }),
    [],
  );
  const bulkActionsState = useBulkActions({
    config: effectiveBulkActions ?? EMPTY_BULK_CONFIG,
  });

  // Determine effective row selection state - bulk actions takes precedence
  const effectiveRowSelection = effectiveBulkActions
    ? bulkActionsState.rowSelection
    : (rowSelection ?? {});
  const effectiveOnRowSelectionChange = effectiveBulkActions
    ? bulkActionsState.onRowSelectionChange
    : onRowSelectionChange;
  const effectiveEnableRowSelection = effectiveBulkActions
    ? true
    : (enableRowSelection ?? false);

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
      ...tableStateOptions,
      // Mirror sort + pagination to the URL (bookmarkable / shareable).
      urlSync: true,
    }),
    [defaultSort, tableStateOptions],
  );

  // ONE tableState owned here and shared by both data hooks. Keeping a single
  // instance means sort/pagination survive the desktop⇄mobile data-mode flip
  // (the two hooks no longer hold divergent state), and only one writer touches
  // the URL.
  const tableState = useTableState(mergedTableStateOptions);

  // Always call both hooks unconditionally (Rules of Hooks).
  // The unused hook has enabled: false so its query won't fire.
  const infiniteResult = useInfiniteTableList<TFilters, TData>({
    queryOptions,
    buildFilters,
    tableState,
    groupBy: groupByField,
    enabled: useInfiniteMode,
  });

  const paginatedResult = useTableList<TFilters, TData>({
    queryOptions,
    buildFilters,
    tableState,
    groupBy: groupByField,
    enabled: !useInfiniteMode,
  });

  const { data, totalCount, isLoading, error, timing, refreshControls } =
    useInfiniteMode ? infiniteResult : paginatedResult;

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
    filters,
    enableRowSelection: effectiveEnableRowSelection,
    combinedExtraActions,
    mappingsMap: effectiveMappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
  });

  // Memoize getRowId to prevent recreating on every render
  const getRowId = useMemo(
    () => (effectiveEnableRowSelection ? (row: TData) => row.id : undefined),
    [effectiveEnableRowSelection],
  );

  // Persisted per-entity column visibility (localStorage), layered over the
  // page's initialColumnVisibility defaults.
  const { columnVisibility, onColumnVisibilityChange } =
    useTableColumnVisibility(entity, initialColumnVisibility);

  // Configure the table
  // In infinite mode, feed all accumulated rows as a single "page" so TanStack Table
  // doesn't try to paginate server-side.
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount: useInfiniteMode ? data.length : totalCount,
    manualPagination: !useInfiniteMode,
    globalFilter,
    onGlobalFilterChange,
    getRowId,
    enableRowSelection: effectiveEnableRowSelection,
    rowSelection: effectiveRowSelection,
    onRowSelectionChange: effectiveOnRowSelectionChange,
    initialColumnVisibility,
    columnVisibility,
    onColumnVisibilityChange,
  });

  // Build bulk action bar element if bulk actions configured
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
    mappingsMap,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    requestDelete,
    infiniteScroll: useInfiniteMode ? infiniteResult.infiniteScroll : undefined,
    refreshControls,
    grouped,
    onGroupedChange,
    groupConfig,
  };
}
