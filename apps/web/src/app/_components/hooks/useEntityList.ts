"use client";

import { useMemo } from "react";
import { type ColumnDef, type Table } from "@tanstack/react-table";
import { type Entity } from "~/entities/types";
import { entities } from "~/entities/entities";
import { useTableList, type UseTableListOptions } from "./useTableList";
import { useTableConfig } from "../data-table/useTableConfig";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { type FilterableColumn } from "../data-table/Table";
import { type UnitMapping } from "~/schemas/unitmapping";
import {
  createImageColumn,
  createNameColumn,
  createCreatedAtColumn,
  createUnitMappingsColumn,
} from "../data-table/columnHelpers";
import { createColumnHelper, type ColumnHelper } from "@tanstack/react-table";

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string;
  createdAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

/** Simple filter definition - string expands to text filter with placeholder */
type FilterDef = string | FilterableColumn;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyColumnDef<TData> = ColumnDef<TData, any>;

export interface UseEntityListOptions<TData extends BaseListRow, TFilters> {
  /** The entity type */
  entity: Entity;
  /** tRPC queryOptions function */
  queryOptions: UseTableListOptions<TFilters>["queryOptions"];
  /** Build filters from table state */
  buildFilters: UseTableListOptions<TFilters>["buildFilters"];
  /** Custom columns (inserted between standard columns) - accepts any accessor type */
  columns: AnyColumnDef<TData>[];
  /** Filter definitions - string shorthand or full FilterableColumn config */
  filters: FilterDef[];
  /** For unit mappings - async function to extract mappings from each row */
  getMappings?: (item: TData) => Promise<UnitMapping[]>;
  /** Override table state options */
  tableStateOptions?: UseTableListOptions<TFilters>["tableStateOptions"];
  /** Global filter state (for custom global filters like IngredientList) */
  globalFilter?: unknown;
  /** Global filter change handler */
  onGlobalFilterChange?: (value: unknown) => void;
}

export interface UseEntityListReturn<TData> {
  /** Configured table instance */
  table: Table<TData>;
  /** Expanded filterable columns config */
  filterableColumns: FilterableColumn[];
  /** Loaded unit mappings map (id -> mappings) */
  mappingsMap: Record<string, UnitMapping[]>;
  /** Raw data array (for edge cases like card view) */
  data: TData[];
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
}

/**
 * Expand a simple filter definition to full FilterableColumn config.
 * String "name" becomes { id: "name", placeholder: "Filter by name..." }
 */
function expandFilterDef(filter: FilterDef): FilterableColumn {
  if (typeof filter === "string") {
    return {
      id: filter,
      placeholder: `Filter by ${filter}...`,
    };
  }
  return filter;
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
 * const { table, filterableColumns, isLoading, error } = useEntityList({
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
 * return <RTable table={table} filterableColumns={filterableColumns} ... />;
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
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<TData> {
  const entityConfig = entities[entity];
  const listConfig = entityConfig.list;
  const standardColumns = listConfig?.standardColumns ?? [];
  const hasUnitMappings = listConfig?.hasUnitMappings ?? false;
  const defaultSort = listConfig?.defaultSort ?? "createdAt";

  // Use the base table list hook
  const { data, totalCount, isLoading, error, tableState } = useTableList<
    TFilters,
    TData
  >({
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

  // Build columns array with standard columns - memoized to prevent infinite re-renders
  // Note: mappingsMap is only included in deps when actually used (hasUnitMappings && getMappings)
  // to avoid re-renders from useAsyncMemo returning new {} references
  const allColumns = useMemo(() => {
    const columnHelper = createColumnHelper<TData>() as ColumnHelper<TData>;
    const cols: AnyColumnDef<TData>[] = [];

    // Prepend standard columns
    if (standardColumns.includes("image")) {
      cols.push(createImageColumn(columnHelper));
    }
    if (standardColumns.includes("name")) {
      cols.push(createNameColumn(columnHelper, entity));
    }

    // Add custom columns
    cols.push(...customColumns);

    // Append unit mappings column if configured
    if (hasUnitMappings && getMappings) {
      cols.push(createUnitMappingsColumn(columnHelper, mappingsMap));
    }

    // Append createdAt column
    if (standardColumns.includes("createdAt")) {
      cols.push(createCreatedAtColumn(columnHelper));
    }

    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsMap only matters when hasUnitMappings && getMappings
  }, [
    customColumns,
    entity,
    getMappings,
    hasUnitMappings,
    standardColumns,
    hasUnitMappings && getMappings ? mappingsMap : null,
  ]);

  // Configure the table
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount,
    globalFilter,
    onGlobalFilterChange,
  });

  // Expand filter definitions - memoized to prevent unnecessary re-renders
  const filterableColumns = useMemo(
    () => filters.map(expandFilterDef),
    [filters],
  );

  return {
    table,
    filterableColumns,
    mappingsMap,
    data,
    isLoading,
    error,
  };
}
