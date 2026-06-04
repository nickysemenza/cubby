import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { ColumnDef, ColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { entities, getSortableFields } from "~/entities/entities";
import {
  createActionsColumn,
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createUnitMappingsColumn,
  type FilterConfig,
} from "../data-table/columnHelpers";
import { buildSelectColumn } from "../data-table/row-selection";

/** Filter definition for use in useEntityList options */
export interface FilterDef {
  id: string;
  placeholder: string;
  filterType?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
}

/** Simple filter definition - string expands to text filter with placeholder */
export type FilterInput = string | FilterDef;

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData> = ColumnDef<TData, any>;

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string;
  createdAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

interface UseStandardColumnsOptions<TData extends BaseListRow> {
  /** The entity type */
  entity: Entity;
  /** Column helper instance (must be memoized) */
  columnHelper: ColumnHelper<TData>;
  /** Custom columns (inserted between standard columns) */
  customColumns: AnyColumnDef<TData>[];
  /** Filter definitions */
  filters: FilterInput[];
  /** Whether row selection is enabled */
  enableRowSelection: boolean;
  /** Combined extra actions renderer for row actions */
  combinedExtraActions?: (row: TData) => ReactNode;
  /** Unit mappings map (id -> mappings), null if not used */
  mappingsMap: Record<string, UnitMapping[]> | null;
  /** Whether unit mappings should be shown */
  hasUnitMappings: boolean;
  /**
   * Width class for the standard name column. Defaults to auto (`min-w-0`).
   * Pass a fixed width (e.g. `w-64`) on sparse tables so the name doesn't
   * balloon to absorb all leftover space under the fixed table layout.
   */
  nameClassName?: string;
}

/**
 * Hook for building standard columns array for entity list tables.
 *
 * Handles:
 * - Select column (if row selection enabled)
 * - Standard columns (image, name, createdAt) based on entity config
 * - Custom columns with auto-sorting based on sortable fields
 * - Unit mappings column
 * - Actions column (always last)
 */
export function useStandardColumns<TData extends BaseListRow>({
  entity,
  columnHelper,
  customColumns,
  filters,
  enableRowSelection,
  combinedExtraActions,
  mappingsMap,
  hasUnitMappings,
  nameClassName,
}: UseStandardColumnsOptions<TData>): AnyColumnDef<TData>[] {
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
  const { standardColumns, shouldUseMappings } = useMemo(() => {
    const entityConfig = entities[entity];
    const listConfig = entityConfig.list;
    return {
      standardColumns: listConfig?.standardColumns ?? [],
      shouldUseMappings:
        (listConfig?.hasUnitMappings ?? false) && hasUnitMappings,
    };
  }, [entity, hasUnitMappings]);

  // Build columns array with standard columns - memoized to prevent infinite re-renders
  return useMemo(() => {
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

    const cols: AnyColumnDef<TData>[] = [];

    // Prepend select column if row selection is enabled
    if (enableRowSelection) {
      cols.push(buildSelectColumn<TData>());
    }

    // Prepend standard columns
    if (standardColumns.includes("image")) {
      cols.push(createImageColumn(columnHelper, { entity }));
    }
    if (standardColumns.includes("name")) {
      const nameFilterConfig = getFilterConfig("name");
      cols.push(
        createNameColumn(columnHelper, entity, "name" as keyof TData, {
          ...(nameFilterConfig ? { filterConfig: nameFilterConfig } : {}),
          className: nameClassName,
        }),
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
    if (shouldUseMappings && mappingsMap) {
      cols.push(createUnitMappingsColumn(columnHelper, mappingsMap));
    }

    // Append createdAt column
    if (standardColumns.includes("createdAt")) {
      cols.push(createCreatedAtColumn(columnHelper));
    }

    // Append actions column (always last)
    cols.push(
      createActionsColumn(columnHelper, entity, {
        extraActions: combinedExtraActions,
      }),
    );

    return cols;
  }, [
    columnHelper,
    stableColumns,
    entity,
    shouldUseMappings,
    standardColumns,
    mappingsMap,
    stableFilters,
    enableRowSelection,
    combinedExtraActions,
    nameClassName,
  ]);
}
