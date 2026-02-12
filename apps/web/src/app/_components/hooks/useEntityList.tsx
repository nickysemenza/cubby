import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
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
import { useTableConfig } from "../data-table/useTableConfig";
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
  /** Override table state options */
  tableStateOptions?: UseTableListOptions<TFilters>["tableStateOptions"];
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
    invalidateKeys: readonly unknown[][];
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
  groupConfig,
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<TData> {
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
  const { deleteBulkAction, combinedExtraActions, deleteDialog } =
    useOptimisticDelete<TData>({ deletable, extraActions });

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

  // Use bulk actions hook if config is provided
  const bulkActionsState = effectiveBulkActions
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - config is stable per usage
      useBulkActions({ config: effectiveBulkActions })
    : null;

  // Determine effective row selection state - bulk actions takes precedence
  const effectiveRowSelection =
    bulkActionsState?.rowSelection ?? rowSelection ?? {};
  const effectiveOnRowSelectionChange =
    bulkActionsState?.onRowSelectionChange ?? onRowSelectionChange;
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
    }),
    [defaultSort, tableStateOptions],
  );

  // Use infinite or paginated table list hook
  const infiniteResult = infinite
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - `infinite` is stable per usage
      useInfiniteTableList<TFilters, TData>({
        queryOptions,
        buildFilters,
        tableStateOptions: mergedTableStateOptions,
        groupBy: groupByField,
      })
    : null;

  const paginatedResult = !infinite
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - `infinite` is stable per usage
      useTableList<TFilters, TData>({
        queryOptions,
        buildFilters,
        tableStateOptions: mergedTableStateOptions,
        groupBy: groupByField,
      })
    : null;

  const {
    data,
    totalCount,
    isLoading,
    error,
    tableState,
    timing,
    refreshControls,
  } = infiniteResult ?? paginatedResult!;

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
  });

  // Memoize getRowId to prevent recreating on every render
  const getRowId = useMemo(
    () => (effectiveEnableRowSelection ? (row: TData) => row.id : undefined),
    [effectiveEnableRowSelection],
  );

  // Configure the table
  // In infinite mode, feed all accumulated rows as a single "page" so TanStack Table
  // doesn't try to paginate server-side.
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount: infinite ? data.length : totalCount,
    manualPagination: !infinite,
    globalFilter,
    onGlobalFilterChange,
    getRowId,
    enableRowSelection: effectiveEnableRowSelection,
    rowSelection: effectiveRowSelection,
    onRowSelectionChange: effectiveOnRowSelectionChange,
  });

  // Build bulk action bar element if bulk actions configured
  const bulkActionBar = useMemo(
    () =>
      bulkActionsState && effectiveBulkActions ? (
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
    infiniteScroll: infiniteResult?.infiniteScroll,
    refreshControls,
    grouped,
    onGroupedChange,
    groupConfig,
  };
}
