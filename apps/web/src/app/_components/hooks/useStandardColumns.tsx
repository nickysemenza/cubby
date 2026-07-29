import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { ColumnDef, ColumnHelper } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo, useRef } from "react";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { entities, getSortableFields } from "~/entities/entities";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import {
  createActionsColumn,
  createCreatedAtColumn,
  createImageColumn,
  createNameColumn,
  createUnitMappingsColumn,
  type FilterConfig,
  multiSelectFilterFn,
} from "../data-table/columnHelpers";
import { buildSelectColumn } from "../data-table/row-selection";

/** Filter definition for use in useEntityList options */
interface FilterDef {
  id: string;
  placeholder: string;
  filterType?: "text" | "select" | "multiselect";
  options?: Array<{ value: string; label: string }>;
}

/** Simple filter definition - string expands to text filter with placeholder */
export type FilterInput = string | FilterDef;

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData> = ColumnDef<TData, any>;

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string | null;
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
  /**
   * Fallback filter definitions for columns the manifest doesn't cover
   * (client-only tables, one-off embedded tables). Entities in
   * `entities/filter-manifest` should declare their filters there instead.
   */
  filters: FilterInput[];
  /**
   * Option lists for manifest specs that name an `optionsKey` — picklists
   * sourced from the server (the project roster, a recipe tag universe) that
   * can't be static module data. MUST be referentially stable (useMemo at the
   * page) or the columns memo churns every render.
   */
  filterOptions?: Record<string, FilterableComboboxItem[]>;
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
  /**
   * Enable inline editing on the standard name column. MUST be referentially
   * stable (memoized by the caller) — it feeds the columns useMemo below.
   */
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
  };
  /** Extra content rendered inline after the standard name column's name. */
  nameSuffix?: (row: TData) => ReactNode;
  /**
   * Render the tree expand/collapse affordance (chevron + depth indent) on the
   * standard name column. Forwarded to `createNameColumn`; inert when unset.
   * Only meaningful when the table wires `getSubRows`/`getExpandedRowModel`.
   */
  expandable?: boolean;
  /**
   * Column ids to render with NO filter control, even though the manifest (or
   * a column factory's own fallback) declares one. For a page that pins that
   * column's value via `useEntityList`'s `extraFilters` — which spreads OVER
   * the manifest-derived filters, so it silently wins — the header control
   * would otherwise be interactive but inert: the user picks a value, the
   * page-level scope clobbers it. E.g. the cookbook detail page's embedded
   * `RecipeList` pins `cookbookId` and hides the Source column's control.
   * May be a fresh array literal each render — internally stabilized like
   * `filters`.
   */
  hiddenFilterColumns?: string[];
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
  filterOptions,
  enableRowSelection,
  combinedExtraActions,
  mappingsMap,
  hasUnitMappings,
  nameClassName,
  nameEditable,
  nameSuffix,
  expandable,
  hiddenFilterColumns,
}: UseStandardColumnsOptions<TData>): AnyColumnDef<TData>[] {
  // Shift-click range selection: anchor (last clicked row id) + modifier flag.
  // Refs are stable across renders, so they don't perturb the useMemo deps below.
  const lastSelectedIdRef = useRef<string | null>(null);
  const shiftKeyRef = useRef(false);

  // Stabilize filters array - only update when serialized content changes
  // This prevents re-renders when consumer passes new array literal each render
  const filtersKey = JSON.stringify(filters);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - using filtersKey for deep comparison
  const stableFilters = useMemo(() => filters, [filtersKey]);

  // Same stabilization for the (much rarer) hidden-columns opt-out.
  const hiddenFilterColumnsKey = JSON.stringify(hiddenFilterColumns ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - using hiddenFilterColumnsKey for deep comparison
  const hiddenFilterColumnSet = useMemo(
    () => new Set(hiddenFilterColumns ?? []),
    [hiddenFilterColumnsKey],
  );

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
    // The filter manifest is the source of truth for what a column can be
    // filtered by; a page-supplied `filters` entry is the fallback for columns
    // (and client-only tables) the manifest doesn't cover.
    const getFilterConfig = (columnId: string): FilterConfig | undefined => {
      if (hiddenFilterColumnSet.has(columnId)) return undefined;

      const fromManifest = manifestFilterConfig(
        entity,
        columnId,
        filterOptions,
      );
      if (fromManifest) return fromManifest;

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

    /**
     * Overlay the manifest's filter control onto one column def.
     *
     * Applies to the columns this hook APPENDS (image, unit mappings) as well
     * as the caller's own — they're real, filterable columns, and a manifest
     * spec pointing at one used to render nothing at all, silently, because
     * only the caller's columns went through the overlay.
     */
    const withManifestFilter = (
      col: AnyColumnDef<TData>,
      colId: string,
    ): AnyColumnDef<TData> => {
      const manifestConfig = getFilterConfig(colId);
      if (!manifestConfig) return col;
      const meta = (col.meta ?? {}) as Record<string, unknown>;
      return {
        ...col,
        // Client-side tables would otherwise resolve a filterFn from the ROW
        // value's type and silently match nothing against an array. Harmless
        // on server-filtered tables, which never run it.
        ...(manifestConfig.filterType === "multiselect"
          ? { filterFn: multiSelectFilterFn }
          : {}),
        meta: { ...meta, filterConfig: manifestConfig },
      };
    };

    const cols: AnyColumnDef<TData>[] = [];

    // Prepend select column if row selection is enabled
    if (enableRowSelection) {
      cols.push(buildSelectColumn<TData>(lastSelectedIdRef, shiftKeyRef));
    }

    // Prepend standard columns
    if (standardColumns.includes("image")) {
      cols.push(
        withManifestFilter(
          createImageColumn(columnHelper, { entity }),
          "image",
        ),
      );
    }
    if (standardColumns.includes("name")) {
      const nameFilterConfig = getFilterConfig("name");
      cols.push(
        createNameColumn(columnHelper, entity, "name" as keyof TData, {
          ...(nameFilterConfig ? { filterConfig: nameFilterConfig } : {}),
          className: nameClassName,
          editable: nameEditable,
          nameSuffix,
          expandable,
        }),
      );
    }

    // Custom columns get two things applied from the registries: sorting from
    // `sortableFields`, and their filter control from the manifest.
    const sortableFields = getSortableFields(entity);
    const processedColumns = customColumns.map((col) => {
      // Get column id from id or accessorKey (need to cast for accessorKey access)
      const accessorCol = col as { accessorKey?: string };
      const colId = col.id ?? accessorCol.accessorKey ?? null;

      // Auto-disable sorting for columns not in sortableFields; an explicit
      // enableSorting on the column def still wins.
      const enableSorting =
        col.enableSorting !== undefined
          ? col.enableSorting
          : colId
            ? sortableFields.includes(colId)
            : false;

      // Manifest config overlays whatever the column factory baked in. The
      // factories' own `filterConfig` (e.g. createFilterableSelectColumn
      // deriving one from its editor options) stays as the fallback for
      // columns and tables the manifest doesn't cover.
      const withSorting = { ...col, enableSorting };
      return colId ? withManifestFilter(withSorting, colId) : withSorting;
    });
    cols.push(...processedColumns);

    // Append unit mappings column if configured
    if (shouldUseMappings && mappingsMap) {
      // The product id stays "unitMappingQuality" — it's what the manifest's
      // presence filter hangs on. NOT sortable: the cell grades conversion
      // COVERAGE (a graph reachability run through the unit engine, over
      // USDA-derived edges the server never loads), which no SQL ORDER BY can
      // reproduce. The old sort ordered by an edge-count proxy instead, i.e.
      // by a quantity that isn't on screen.
      const mappingsColId =
        entity === "product" ? "unitMappingQuality" : "unitMappings";
      cols.push(
        withManifestFilter(
          createUnitMappingsColumn(columnHelper, mappingsMap, {
            id: mappingsColId,
            enableSorting: false,
          }),
          mappingsColId,
        ),
      );
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
    customColumns,
    entity,
    shouldUseMappings,
    standardColumns,
    mappingsMap,
    stableFilters,
    filterOptions,
    enableRowSelection,
    combinedExtraActions,
    nameClassName,
    nameEditable,
    nameSuffix,
    expandable,
    hiddenFilterColumnSet,
  ]);
}
