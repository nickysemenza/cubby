import {
  entityInspectorMetadata,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { ColumnVisibilityState } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { defaultSortDirectionFor, defaultSortFor } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";

import type { EntityActionSubject } from "../actions/entity-actions";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import { useRevealTableColumnsOnce } from "../data-table/column-layout";
import type { RowLinkResolver } from "../data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  createCubbyColumnHelper,
} from "../data-table/table-features";
import {
  type TableStateReturn,
  useTableState,
} from "../data-table/useTableState";
import type { RuntimeFilterOptions } from "./filter-option-types";
import type { DeletableConfig } from "./useDeletableConfig";
import type { BaseListRow } from "./useEntityList";
import { useListBulkActions } from "./useListBulkActions";
import { useOptimisticDelete } from "./useOptimisticDelete";
import {
  useRelatedPreviewColumnDefs,
  useRelatedPreviewData,
  useRelatedPreviewStateRef,
} from "./useRelatedPreviewColumns";
import { type FilterInput, useStandardColumns } from "./useStandardColumns";

const NO_FILTERS: FilterInput[] = [];
type SelectionScope = object;
type ListTreeNode = {
  id: string;
  subRows?: readonly ListTreeNode[];
};

/** Shared state/action half: it must run before a server adapter fetches rows. */
export function useEntityListPresentationState<TData extends BaseListRow>({
  entity,
  tableStateOptions,
  deletable,
  extraActions,
  bulkActions,
  onInspectRow,
  includeCatalogActions,
  selectable,
  deleteEmptyLabel,
  selectionScope,
}: {
  entity: BrowserRoutedEntity;
  tableStateOptions?: Parameters<typeof useTableState>[0];
  deletable?: DeletableConfig;
  extraActions?: (row: TData) => ReactNode;
  bulkActions?: BulkActionsConfig<TData>;
  onInspectRow?: (row: { id?: string; original: TData }) => void;
  includeCatalogActions?: boolean;
  /** See `useListBulkActions`: no checkbox column or bulk bar, row menu kept. */
  selectable?: boolean;
  deleteEmptyLabel?: (row: TData) => string;
  selectionScope: (tableState: TableStateReturn) => SelectionScope;
}) {
  const { deleteActionDefinition, deleteDialog, requestDelete } =
    useOptimisticDelete<TData>({
      deletable,
      extraActions,
      emptyLabel: deleteEmptyLabel,
    });
  const additionalActions = useMemo(
    () => (deleteActionDefinition ? [deleteActionDefinition] : []),
    [deleteActionDefinition],
  );
  const listBulkActions = useListBulkActions({
    entity,
    bulkActions,
    additionalActions,
    onInspectRow,
    includeCatalogActions,
    selectable,
  });
  const defaultSort = defaultSortFor(entity);
  // The manifest declares direction alongside the field, so a name-sorted
  // roster opens A→Z instead of the table's blanket descending default.
  const defaultSortDesc = defaultSortDirectionFor(entity) !== "asc";
  const mergedTableStateOptions = useMemo(
    () => ({
      initialSort: defaultSort,
      initialSortDesc: defaultSortDesc,
      urlSync: true,
      filterSpecs: getEntityFilters(entity),
      primarySearch: entityInspectorMetadata[entity].primarySearch,
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
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [selectionScopeKey, listBulkActions.state.clearSelection]);
  return {
    tableState,
    currentSelectionScope,
    listBulkActions,
    combinedExtraActions: extraActions,
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
  subject,
}: {
  entity: BrowserRoutedEntity;
  data: readonly { id: string }[];
  columns: CubbyColumnCollection<TData>;
  filters?: FilterInput[];
  filterOptions?: RuntimeFilterOptions;
  initialColumnVisibility?: Record<string, boolean>;
  transientColumnVisibility?: Record<string, boolean>;
  revealColumns?: { key: string; visibility: Record<string, boolean> };
  state: ReturnType<typeof useEntityListPresentationState<TData>>;
  supportsServerSorting: boolean;
  mappingsMap?: Record<string, UnitMapping[]> | null;
  hasUnitMappings?: boolean;
  nameClassName?: string;
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
    getValue?: (row: TData) => string | null;
  };
  nameSuffix?: (row: TData) => ReactNode;
  namePrefix?: (row: TData) => ReactNode;
  hiddenFilterColumns?: string[];
  expandable?: boolean;
  rowLink?: RowLinkResolver<TData>;
  rowActionGuard?: (row: TData) => boolean;
  /** What each row is about, when that is a different record. */
  subject?: (row: TData) => EntityActionSubject | null;
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
    const visit = (rows: readonly ListTreeNode[]) => {
      for (const row of rows) {
        ids.push(row.id);
        const children = row.subRows;
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
    () =>
      createCubbyColumnCollection<TData>((add) => {
        customColumns.visit(add);
        for (const column of relatedColumns) add(column);
      }),
    [customColumns, relatedColumns],
  );
  const guardedExtraActions = useMemo(
    () =>
      rowActionGuard
        ? (row: TData) =>
            rowActionGuard(row) ? state.combinedExtraActions?.(row) : null
        : state.combinedExtraActions,
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
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
    subject,
  });
  // Lifted here (rather than left to `useTableConfig`'s own internal
  // fallback) because this hook needs to read visibility live, before the
  // table exists, to decide which related columns are worth fetching preview
  // data for. The caller feeds `columnVisibility`/`setColumnVisibility` back
  // into `useTableConfig` as its controlled visibility state.
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>(mergedInitialColumnVisibility);
  useRevealTableColumnsOnce(setColumnVisibility, revealColumns);
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
    columnVisibility,
    setColumnVisibility,
    initialColumnVisibility: mergedInitialColumnVisibility,
    rowContentVersion,
  };
}
