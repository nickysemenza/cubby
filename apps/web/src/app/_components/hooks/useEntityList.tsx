import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
  Table,
} from "@tanstack/react-table";
import { type ColumnHelper, createColumnHelper } from "@tanstack/react-table";
import { Trash } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeleteEntityDialog } from "~/components/dialogs/delete-entity-dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import { entities, getSortableFields } from "~/entities/entities";
import type { Entity } from "~/entities/types";
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
}: UseEntityListOptions<TData, TFilters>): UseEntityListReturn<TData> {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<TData | null>(null);

  // Create columnHelper once - CRITICAL to prevent infinite re-renders
  const columnHelper = useMemo(
    () => createColumnHelper<TData>() as ColumnHelper<TData>,
    [],
  );

  // Memoize the mutation options to prevent infinite re-renders
  const deleteMutationOptions = useMemo(() => {
    if (!deletable) return null;

    // Get base mutation options from tRPC
    const baseMutationOptions = deletable.mutationOptions({
      onSuccess: () => {
        toast.success(`${deletable.entityLabel} deleted`);
        // Refetch to ensure data is in sync with server
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        for (const key of deletable.invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: [key as unknown[]] });
        }
      },
      onError: (err) => {
        toast.error(
          err.message ||
            `Failed to delete ${deletable.entityLabel.toLowerCase()}`,
        );
      },
    }) as Record<string, unknown>;

    // Extend with optimistic updates
    return {
      ...baseMutationOptions,
      onMutate: async (variables: { ids: string[] }) => {
        // Cancel any outgoing refetches to prevent them from overwriting optimistic update
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        for (const key of deletable.invalidateKeys) {
          await queryClient.cancelQueries({ queryKey: [key as unknown[]] });
        }

        // Snapshot the previous value for rollback
        const previousData: Array<unknown> = [];
        for (const key of deletable.invalidateKeys) {
          const currentData = queryClient.getQueryData([key as unknown[]]);
          previousData.push(currentData);
        }

        // Optimistically remove deleted items from all relevant queries
        for (const key of deletable.invalidateKeys) {
          queryClient.setQueryData([key as unknown[]], (old: unknown) => {
            if (!old || typeof old !== "object") {
              return old;
            }
            if (
              !("data" in old) ||
              !Array.isArray((old as { data?: unknown }).data)
            ) {
              return old;
            }

            const oldData = old as { data: Array<{ id: string }> };
            const newData = {
              ...oldData,
              data: oldData.data.filter(
                (item) => !variables.ids.includes(item.id),
              ),
            };
            return newData;
          });
        }

        return { previousData };
      },
      onError: (
        err: unknown,
        _variables: unknown,
        context: { previousData?: unknown[] } | undefined,
      ) => {
        // Roll back optimistic update on error
        if (context?.previousData) {
          deletable.invalidateKeys.forEach((key, index) => {
            // Wrap key in array to match tRPC's nested structure
            queryClient.setQueryData(
              [key as unknown[]],
              context.previousData?.[index],
            );
          });
        }
        // Call the base onError from tRPC (cast to avoid type mismatch)
        if (baseMutationOptions.onError) {
          (
            baseMutationOptions.onError as (
              err: unknown,
              variables: unknown,
              context: unknown,
            ) => void
          )(err, _variables, context);
        }
      },
    };
  }, [deletable, queryClient]);

  // Delete mutation (only created if deletable is provided)
  const deleteMutation = deleteMutationOptions
    ? // biome-ignore lint/correctness/useHookAtTopLevel: Conditional use is intentional - config is stable per usage
      useMutation(deleteMutationOptions as Parameters<typeof useMutation>[0])
    : null;
  // Combine user's bulk actions with delete bulk action if deletable is provided
  const effectiveBulkActions = useMemo(():
    | BulkActionsConfig<TData>
    | undefined => {
    if (!deletable && !bulkActions) return undefined;

    const deleteAction = deletable
      ? {
          id: "delete" as const,
          label: "Delete",
          icon: <Trash className="h-4 w-4" />,
          requiresConfirmation: true,
          onExecute: async (selectedRows: { original: TData }[]) => {
            await deleteMutation!.mutateAsync({
              ids: selectedRows.map((row) => row.original.id),
            });
            return { success: true };
          },
        }
      : null;

    const userActions = bulkActions?.actions ?? [];
    const combinedActions = deleteAction
      ? [...userActions, deleteAction]
      : userActions;

    return {
      ...bulkActions,
      actions: combinedActions,
    };
  }, [deletable, bulkActions, deleteMutation]);

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

  // Combine user's extra actions with delete action if deletable is provided
  const combinedExtraActions = useMemo(() => {
    if (!deletable && !extraActions) return undefined;

    return (row: TData) => (
      <>
        {extraActions?.(row)}
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(row);
              }}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }, [deletable, extraActions]);
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

  // Memoize table state options to prevent recreating on every render
  const mergedTableStateOptions = useMemo(
    () => ({
      initialSort: defaultSort,
      ...tableStateOptions,
    }),
    [defaultSort, tableStateOptions],
  );

  // Use the base table list hook
  const { data, totalCount, isLoading, error, tableState, timing } =
    useTableList<TFilters, TData>({
      queryOptions,
      buildFilters,
      tableStateOptions: mergedTableStateOptions,
    });

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
    effectiveMappingsMap,
    stableFilters,
    effectiveEnableRowSelection,
    combinedExtraActions,
  ]);

  // Memoize getRowId to prevent recreating on every render
  const getRowId = useMemo(
    () => (effectiveEnableRowSelection ? (row: TData) => row.id : undefined),
    [effectiveEnableRowSelection],
  );

  // Configure the table
  const table = useTableConfig({
    data,
    columns: allColumns,
    tableState,
    totalCount,
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

  // Build delete dialog element if deletable is enabled
  const deleteDialog = useMemo(
    () =>
      deletable ? (
        <DeleteEntityDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          items={
            deleteTarget
              ? [
                  {
                    id: deleteTarget.id,
                    name: deleteTarget.name ?? deleteTarget.id,
                  },
                ]
              : []
          }
          entityType={deletable.entityLabel}
          onDelete={async () => {
            if (deleteTarget) {
              await deleteMutation!.mutateAsync({ ids: [deleteTarget.id] });
              setDeleteTarget(null);
            }
          }}
          isPending={deleteMutation?.isPending ?? false}
        />
      ) : null,
    [deletable, deleteTarget, deleteMutation],
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
  };
}
