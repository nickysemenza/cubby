import { useCallback, useMemo } from "react";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import type { ListWorkbenchModel } from "../data-table/ListWorkbench";
import type { CubbyRow as Row } from "../data-table/table-features";
import { useTableConfig } from "../data-table/useTableConfig";
import { useContractDeletable } from "./useDeletableConfig";
import type {
  BaseListRow,
  UseEntityListOptions,
  UseEntityListReturn,
} from "./useEntityList";
import {
  useEntityListPresentation,
  useEntityListPresentationState,
} from "./useEntityListPresentation";
import { ListBulkActionBar } from "./useListBulkActions";
import type { FilterInput } from "./useStandardColumns";

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
  | "layoutKey"
  | "legacyLayoutVisibilityKey"
  | "legacyLayoutSizingKey"
  | "deleteEmptyLabel"
  | "hiddenFilterColumns"
  | "subject"
>;

interface UseClientEntityListOptions<TData extends BaseListRow>
  extends SharedListOptions<TData> {
  /** Caller-provided rows (already filtered/assembled). No query is run. */
  data: TData[];
  /** Query state when the caller-provided rows still come from an async read. */
  isLoading?: boolean;
  error?: unknown;
  /** Filter definitions (optional; defaults to none). */
  filters?: FilterInput[];
  /** Opt-in expandable tree (TanStack getSubRows/getExpandedRowModel). */
  tree?: ClientTreeConfig<TData>;
  /**
   * Which rows the bulk actions can target, for a table whose rows come from
   * more than one source. A false row gets NO checkbox rather than a dead one
   * (`row-selection.tsx`), so select-all skips it and no bulk action can reach
   * a row it has no record to act on.
   *
   * The flat-list counterpart of `EntityListTreeConfig.rowIsEntity`, which does
   * the same job for a tree whose children are a different entity.
   */
  rowIsEntity?: (row: TData) => boolean;
  /**
   * Bulk actions configuration — combined with the delete bulk action (if
   * `deletable` is set), mirroring `useEntityList`'s `bulkActions`. Must be
   * referentially stable (wrap in `useMemo`) or the columns/table config churn
   * every render.
   */
  bulkActions?: BulkActionsConfig<TData>;
}

/** Client rows produce the same rendering module as server-backed lists. */
interface UseClientEntityListReturn<TData extends BaseListRow> {
  workbench: ListWorkbenchModel<TData>;
  requestDelete: UseEntityListReturn<TData>["requestDelete"];
}

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
  isLoading,
  error,
  columns: customColumns,
  filters,
  hiddenFilterColumns,
  deletable,
  extraActions,
  nameEditable,
  nameSuffix,
  tableStateOptions,
  initialColumnVisibility,
  layoutKey,
  legacyLayoutVisibilityKey,
  legacyLayoutSizingKey,
  tree,
  rowIsEntity,
  bulkActions,
  deleteEmptyLabel,
  subject,
}: UseClientEntityListOptions<TData>): UseClientEntityListReturn<TData> {
  const clientTableStateOptions = useMemo(
    () => ({
      initialPagination: { pageIndex: 0, pageSize: DEFAULT_CLIENT_PAGE_SIZE },
      ...tableStateOptions,
    }),
    [tableStateOptions],
  );
  const resolvedDeletable = useContractDeletable(entity, deletable);
  const presentationState = useEntityListPresentationState<TData>({
    entity,
    tableStateOptions: clientTableStateOptions,
    deletable: resolvedDeletable,
    extraActions,
    bulkActions,
    deleteEmptyLabel,
    selectionScope: (state) => state.allFilters,
  });
  const { tableState } = presentationState;
  const presentation = useEntityListPresentation<TData>({
    entity,
    data,
    columns: customColumns,
    filters,
    initialColumnVisibility,
    layoutKey,
    legacyLayoutVisibilityKey,
    legacyLayoutSizingKey,
    state: presentationState,
    supportsServerSorting: false,
    hiddenFilterColumns,
    nameEditable,
    nameSuffix,
    expandable: tree?.expandable,
  });
  const {
    allColumns,
    layout,
    initialColumnVisibility: mergedInitialColumnVisibility,
    rowContentVersion,
  } = presentation;

  const getRowId = useCallback((row: TData) => row.id, []);

  // Boolean for the columns (does a selection column exist at all), predicate
  // for the table (which rows it applies to).
  const rowSelectionEnabled = useMemo(
    () =>
      !presentationState.listBulkActions.enableRowSelection
        ? false
        : rowIsEntity
          ? (row: Row<TData>) => rowIsEntity(row.original)
          : true,
    [presentationState.listBulkActions.enableRowSelection, rowIsEntity],
  );

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
    enableRowSelection: rowSelectionEnabled,
    rowSelection: presentationState.listBulkActions.rowSelection,
    onRowSelectionChange:
      presentationState.listBulkActions.onRowSelectionChange,
    layout,
    initialColumnVisibility: mergedInitialColumnVisibility,
    getSubRows: tree?.getSubRows,
    filterFromLeafRows: tree?.filterFromLeafRows,
    paginateExpandedRows: tree?.paginateExpandedRows,
    autoResetExpanded: tree?.autoResetExpanded,
    rowContentVersion,
  });

  const bulkActionBar = presentationState.listBulkActions.config ? (
    <ListBulkActionBar
      table={table}
      config={presentationState.listBulkActions.config}
      state={presentationState.listBulkActions.state}
    />
  ) : null;

  return {
    workbench: {
      entity,
      table,
      isLoading,
      error,
      bulkActionBar,
      subjectEntity: subject?.entity,
      deleteDialog: presentationState.deleteDialog,
    },
    requestDelete: presentationState.requestDelete,
  };
}
