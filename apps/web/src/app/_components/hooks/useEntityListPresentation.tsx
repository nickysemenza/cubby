import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { QueryKey } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { browserEntityDefinition } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import type { RowLinkResolver } from "../data-table/columnHelpers";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
} from "../data-table/table-features";
import {
  useCubbyTableLayout,
  useRevealTableColumnsOnce,
} from "../data-table/table-layout";
import {
  type TableStateReturn,
  useTableState,
} from "../data-table/useTableState";
import type { RuntimeFilterOptions } from "./filter-option-types";
import type { BaseListRow } from "./useEntityList";
import { useListBulkActions } from "./useListBulkActions";
import { useOptimisticDelete } from "./useOptimisticDelete";
import {
  useRelatedPreviewColumnDefs,
  useRelatedPreviewData,
  useRelatedPreviewStateRef,
} from "./useRelatedPreviewColumns";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

// biome-ignore lint/suspicious/noExplicitAny: column accessors intentionally vary.
type AnyColumnDef<TData extends BaseListRow> = CubbyColumnDef<TData, any>;
const NO_FILTERS: FilterInput[] = [];

type DeleteConfig = {
  mutationOptions: (callbacks: {
    onSuccess: () => void;
    onError: (err: { message?: string }) => void;
  }) => unknown;
  entityLabel: string;
  invalidateKeys: readonly QueryKey[];
  entity: Entity;
};

/** Shared state/action half: it must run before a server adapter fetches rows. */
export function useEntityListPresentationState<TData extends BaseListRow>({
  entity,
  tableStateOptions,
  deletable,
  extraActions,
  bulkActions,
  deleteEmptyLabel,
  selectionScope,
}: {
  entity: BrowserRoutedEntity;
  tableStateOptions?: Parameters<typeof useTableState>[0];
  deletable?: DeleteConfig;
  extraActions?: (row: TData) => ReactNode;
  bulkActions?: BulkActionsConfig<TData>;
  deleteEmptyLabel?: (row: TData) => string;
  selectionScope: (tableState: TableStateReturn) => unknown;
}) {
  const {
    deleteBulkAction,
    combinedExtraActions,
    deleteDialog,
    requestDelete,
  } = useOptimisticDelete<TData>({
    deletable,
    extraActions,
    emptyLabel: deleteEmptyLabel,
  });
  const listBulkActions = useListBulkActions({
    entity,
    bulkActions,
    deleteBulkAction,
  });
  const listConfig = useMemo(
    () => browserEntityDefinition(entity).list,
    [entity],
  );
  const defaultSort = listConfig?.defaultSort ?? "createdAt";
  // The registry declares direction alongside the field, so a name-sorted
  // roster opens A→Z instead of the table's blanket descending default.
  const defaultSortDesc = listConfig?.defaultSortDirection !== "asc";
  const mergedTableStateOptions = useMemo(
    () => ({
      initialSort: defaultSort,
      initialSortDesc: defaultSortDesc,
      urlSync: true,
      filterSpecs: getEntityFilters(entity),
      ...tableStateOptions,
    }),
    [defaultSort, defaultSortDesc, entity, tableStateOptions],
  );
  const tableState = useTableState(mergedTableStateOptions);
  const currentSelectionScope = selectionScope(tableState);
  const selectionScopeKey = useMemo(
    () => JSON.stringify(currentSelectionScope),
    [currentSelectionScope],
  );
  const previousSelectionScopeKeyRef = useRef(selectionScopeKey);
  useEffect(() => {
    if (previousSelectionScopeKeyRef.current === selectionScopeKey) return;
    previousSelectionScopeKeyRef.current = selectionScopeKey;
    listBulkActions.state.clearSelection();
  }, [selectionScopeKey, listBulkActions.state.clearSelection]);
  return {
    tableState,
    currentSelectionScope,
    listBulkActions,
    combinedExtraActions,
    deleteDialog,
    requestDelete,
    urlSync: mergedTableStateOptions.urlSync,
  };
}

/**
 * Shared presentation half for server and client list adapters: persisted
 * layout, standard/related columns, delete/bulk actions, and preview data.
 * Query membership, server pagination/grouping/select-all, and client-tree
 * expansion remain in their adapters because their behavior is not shared.
 */
export function useEntityListPresentation<TData extends BaseListRow>({
  entity,
  data,
  columns: customColumns,
  filters,
  filterOptions,
  initialColumnVisibility,
  transientColumnVisibility,
  revealColumns,
  layoutKey,
  legacyLayoutVisibilityKey,
  legacyLayoutSizingKey,
  state,
  supportsServerSorting,
  mappingsMap = null,
  hasUnitMappings = false,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  hiddenFilterColumns,
  expandable,
  rowLink,
  rowActionGuard,
}: {
  entity: BrowserRoutedEntity;
  data: readonly { id: string }[];
  columns: AnyColumnDef<TData>[];
  filters?: FilterInput[];
  filterOptions?: RuntimeFilterOptions;
  initialColumnVisibility?: Record<string, boolean>;
  transientColumnVisibility?: Record<string, boolean>;
  revealColumns?: { key: string; visibility: Record<string, boolean> };
  layoutKey?: string;
  legacyLayoutVisibilityKey?: string;
  legacyLayoutSizingKey?: string;
  state: ReturnType<typeof useEntityListPresentationState<TData>>;
  supportsServerSorting: boolean;
  mappingsMap?: Record<string, UnitMapping[]> | null;
  hasUnitMappings?: boolean;
  nameClassName?: string;
  nameEditable?: { onSave: (newValue: string, row: TData) => Promise<void> };
  nameSuffix?: (row: TData) => ReactNode;
  namePrefix?: (row: TData) => ReactNode;
  hiddenFilterColumns?: string[];
  expandable?: boolean;
  rowLink?: RowLinkResolver<TData>;
  rowActionGuard?: (row: TData) => boolean;
}) {
  const columnHelper = useMemo(() => createCubbyColumnHelper<TData>(), []);
  const relatedViews = useMemo(() => relatedViewsFor(entity), [entity]);
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
      ...transientColumnVisibility,
      ...initialColumnVisibility,
    }),
    [
      initialColumnVisibility,
      relatedInitialVisibility,
      transientColumnVisibility,
    ],
  );
  const sourceIds = useMemo(() => {
    const ids: string[] = [];
    const visit = (rows: readonly { id: string }[]) => {
      for (const row of rows) {
        ids.push(row.id);
        const children = (row as { subRows?: readonly { id: string }[] })
          .subRows;
        if (children) visit(children);
      }
    };
    visit(data);
    return ids;
  }, [data]);
  const relatedStateRef = useRelatedPreviewStateRef();
  const relatedColumns = useRelatedPreviewColumnDefs({
    entity,
    relatedViews,
    columnHelper,
    filterOptions,
    supportsServerSorting,
    relatedStateRef,
  });
  const combinedCustomColumns = useMemo(
    () => [...customColumns, ...relatedColumns],
    [customColumns, relatedColumns],
  );
  const guardedExtraActions = useMemo(
    () =>
      rowActionGuard
        ? (row: TData) =>
            rowActionGuard(row) ? state.combinedExtraActions?.(row) : null
        : state.combinedExtraActions,
    [rowActionGuard, state.combinedExtraActions],
  );
  const allColumns = useStandardColumns<TData>({
    entity,
    columnHelper,
    customColumns: combinedCustomColumns,
    filters: filters ?? NO_FILTERS,
    filterOptions,
    enableRowSelection: state.listBulkActions.enableRowSelection,
    combinedExtraActions: guardedExtraActions,
    mappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
    nameSuffix,
    namePrefix,
    hiddenFilterColumns,
    expandable,
    rowLink,
  });
  const persistedLayoutKey = layoutKey ?? entity;
  const layout = useCubbyTableLayout({
    key: persistedLayoutKey,
    columns: allColumns,
    initialColumnVisibility: mergedInitialColumnVisibility,
    legacyVisibilityKey: legacyLayoutVisibilityKey ?? persistedLayoutKey,
    legacySizingKey: legacyLayoutSizingKey ?? persistedLayoutKey,
  });
  useRevealTableColumnsOnce(layout, revealColumns);
  const columnVisibility = useStore(layout.atoms.columnVisibility);
  const visibleRelatedKeys = useMemo(
    () =>
      relatedViews
        .filter((view) => columnVisibility[`related:${view.key}`] !== false)
        .map((view) => view.key),
    [columnVisibility, relatedViews],
  );
  const rowContentVersion = useRelatedPreviewData({
    entity,
    sourceIds,
    visibleRelationKeys: visibleRelatedKeys,
    relatedStateRef,
  });
  return {
    allColumns,
    layout,
    initialColumnVisibility: mergedInitialColumnVisibility,
    rowContentVersion,
  };
}
