import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
  Table,
} from "@tanstack/react-table";
import { type ColumnHelper, createColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { entities, getSortableFields } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import type { QueryTiming } from "~/lib/query-timing";
import type { UnitMapping } from "~/schemas/unitmapping";
import { BulkActionBar } from "../data-table/BulkActionBar";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import {
  createActionsColumn,
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createUnitMappingsColumn,
  type FilterConfig,
} from "../data-table/columnHelpers";
import { buildSelectColumn } from "../data-table/row-selection";
import { useBulkActions } from "../data-table/useBulkActions";
import { useTableConfig } from "../data-table/useTableConfig";

import { type UseTableListOptions, useTableList } from "./useTableList";

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string;
  createdAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

/** Filter definition for use in useEntityList options */
interface FilterDef {
  id: string;
  placeholder: string;
  filterType?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
}

/** Simple filter definition - string expands to text filter with placeholder */
type FilterInput = string | FilterDef;

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
  /** For unit mappings - function to extract mappings from each row (sync or async) */
  getMappings?: (item: TData) => UnitMapping[] | Promise<UnitMapping[]>;
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
}

/**
 * Hook for managing entity list pages with common conventions.
 *
 * Handles:
 * - Table query via useTableList
 * - Async unit mappings loading if getMappings provided
 * - Standard columns based on entity config (image, name, createdAt)
 * - Filter expansion from simple string definitions
 *
 * @example
 * ```tsx
 * const { table, isLoading, error } = useEntityList({
 *   entity: "product",
 *   queryOptions: api.product.list.queryOptions,
 *   buildFilters: (ts) => ({
 *     nameFilter: ts.getColumnFilter("name"),
 *     manufacturerFilter: ts.getColumnFilter("manufacturer"),
 *   }),
 *   getMappings: getAllUnitMappingsFromProduct,
 *   columns: [
 *     columnHelper.accessor("manufacturer", { ... }),
 *     columnHelper.accessor("upc", { ... }),
 *   ],
 *   filters: ["name", "manufacturer"],
 * });
 *
 * return <RTable table={table} isLoading={isLoading} error={error} />;
 * ```
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
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<TData> {
  // Use bulk actions hook if config is provided
  const bulkActionsState = bulkActions
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - config is stable per usage
      useBulkActions({ config: bulkActions })
    : null;

  // Determine effective row selection state - bulk actions takes precedence
  const effectiveRowSelection =
    bulkActionsState?.rowSelection ?? rowSelection ?? {};
  const effectiveOnRowSelectionChange =
    bulkActionsState?.onRowSelectionChange ?? onRowSelectionChange;
  const effectiveEnableRowSelection = bulkActions
    ? true
    : (enableRowSelection ?? false);
  // Stabilize filters array - only update when serialized content changes
  // This prevents re-renders when consumer passes new array literal each render
  const filtersKey = JSON.stringify(filters);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - using filtersKey for deep comparison
  const stableFilters = useMemo(() => filters, [filtersKey]);

  // Stabilize columns array - only update when length changes
  // (column definitions are typically static, changes in length indicate real updates)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - columns are static, length change indicates real update
  const stableColumns = useMemo(() => customColumns, [customColumns.length]);

  // Memoize entity config to prevent re-renders when entity doesn't change
  const { standardColumns, hasUnitMappings, defaultSort } = useMemo(() => {
    const entityConfig = entities[entity];
    const listConfig = entityConfig.list;
    return {
      standardColumns: listConfig?.standardColumns ?? [],
      hasUnitMappings: listConfig?.hasUnitMappings ?? false,
      defaultSort: listConfig?.defaultSort ?? "createdAt",
    };
  }, [entity]);

  // Use the base table list hook
  const { data, totalCount, isLoading, error, tableState, timing } =
    useTableList<TFilters, TData>({
      queryOptions,
      buildFilters,
      tableStateOptions: {
        initialSort: defaultSort,
        ...tableStateOptions,
      },
    });

  // Load unit mappings asynchronously if getMappings is provided
  const mappingsMap = useAsyncMemo(
    async (signal) => {
      if (!getMappings || !hasUnitMappings) return {};
      const entries = await Promise.all(
        data.map(async (item) => {
          const mappings = await getMappings(item);
          return [item.id, mappings] as const;
        }),
      );
      if (signal.cancelled) return {};
      return Object.fromEntries(entries);
    },
    [data, getMappings, hasUnitMappings],
    {},
  );

  // Track mappings only when they're actually used to avoid re-renders from useAsyncMemo returning new {} references
  const shouldUseMappings = hasUnitMappings && getMappings;
  const effectiveMappingsMap = shouldUseMappings ? mappingsMap : null;

  // Build columns array with standard columns - memoized to prevent infinite re-renders
  const allColumns = useMemo(() => {
    // Convert FilterDef to FilterConfig for column meta
    const getFilterConfig = (columnId: string): FilterConfig | undefined => {
      const filterDef = stableFilters.find((f) =>
        typeof f === "string" ? f === columnId : f.id === columnId,
      );
      if (!filterDef) return undefined;
      if (typeof filterDef === "string") {
        return { placeholder: `Filter by ${filterDef}...` };
      }
      return {
        placeholder: filterDef.placeholder,
        filterType: filterDef.filterType,
        options: filterDef.options,
      };
    };

    const columnHelper = createColumnHelper<TData>() as ColumnHelper<TData>;
    const cols: AnyColumnDef<TData>[] = [];

    // Prepend select column if row selection is enabled
    if (effectiveEnableRowSelection) {
      cols.push(buildSelectColumn<TData>());
    }

    // Prepend standard columns
    if (standardColumns.includes("image")) {
      cols.push(createImageColumn(columnHelper));
    }
    if (standardColumns.includes("name")) {
      const nameFilterConfig = getFilterConfig("name");
      cols.push(
        createNameColumn(
          columnHelper,
          entity,
          "name" as keyof TData,
          nameFilterConfig ? { filterConfig: nameFilterConfig } : undefined,
        ),
      );
    }

    // Add custom columns with automatic enableSorting based on sortableFields
    const sortableFields = getSortableFields(entity);
    const processedColumns = stableColumns.map((col) => {
      // If enableSorting is explicitly set, respect it
      if (col.enableSorting !== undefined) return col;
      // Get column id from id or accessorKey (need to cast for accessorKey access)
      const accessorCol = col as { accessorKey?: string };
      const colId = col.id ?? accessorCol.accessorKey ?? null;
      // Auto-disable sorting for columns not in sortableFields
      const canSort = colId ? sortableFields.includes(colId) : false;
      return { ...col, enableSorting: canSort };
    });
    cols.push(...processedColumns);

    // Append unit mappings column if configured
    if (shouldUseMappings && effectiveMappingsMap) {
      cols.push(createUnitMappingsColumn(columnHelper, effectiveMappingsMap));
    }

    // Append createdAt column
    if (standardColumns.includes("createdAt")) {
      cols.push(createCreatedAtColumn(columnHelper));
    }

    // Append actions column (always last)
    cols.push(createActionsColumn(columnHelper, entity));

    return cols;
  }, [
    stableColumns,
    entity,
    shouldUseMappings,
    standardColumns,
    effectiveMappingsMap,
    stableFilters,
    effectiveEnableRowSelection,
  ]);

  // Configure the table
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount,
    globalFilter,
    onGlobalFilterChange,
    getRowId: effectiveEnableRowSelection ? (row) => row.id : undefined,
    enableRowSelection: effectiveEnableRowSelection,
    rowSelection: effectiveRowSelection,
    onRowSelectionChange: effectiveOnRowSelectionChange,
  });

  // Build bulk action bar element if bulk actions configured
  const bulkActionBar =
    bulkActionsState && bulkActions ? (
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
    ) : null;

  return {
    table,
    mappingsMap,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
  };
}
