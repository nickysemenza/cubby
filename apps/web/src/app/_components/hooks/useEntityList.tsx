import type { Entity } from "@cubby/schemas/entity";
import {
  entityInspectorMetadata,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import {
  LOCATION_UNSPECIFIED_GROUP_KEY,
  PRODUCT_UNCLASSIFIED_GROUP_KEY,
} from "@cubby/schemas/pagination";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { browserEntityDefinition, entities } from "~/entities/entities";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
  summarizeListState,
} from "~/entities/filters";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

import type { EntityActionSubject } from "../actions/entity-actions";
import {
  bulkActionPreview,
  type BulkActionsConfig,
} from "../data-table/bulk-actions.types";
import type { RowLinkResolver } from "../data-table/columnHelpers";
import type { ServerListWorkbenchModel } from "../data-table/ListWorkbench";
import { problemWorklistState } from "../data-table/problem-worklist";
import { reconcileRowSelection } from "../data-table/row-selection";
import type { CubbyColumnCollection } from "../data-table/table-features";
import type { GroupConfig } from "../data-table/useGroupedList";
import { useTableConfig } from "../data-table/useTableConfig";
import type {
  TableStateReturn,
  useTableState,
} from "../data-table/useTableState";
import type { RuntimeFilterOptions } from "./filter-option-types";
import {
  type DeletableConfig,
  useContractDeletable,
} from "./useDeletableConfig";
import {
  useEntityListPresentation,
  useEntityListPresentationState,
} from "./useEntityListPresentation";
import {
  useEntityPreview,
  type UseEntityPreviewOptions,
} from "./useEntityPreview";
import { useInfiniteTableList } from "./useInfiniteTableList";
import { ListBulkActionBar } from "./useListBulkActions";
import type { ListQueryOptionsFn } from "./usePaginatedTableCore";
import type { FilterInput } from "./useStandardColumns";

export interface BaseListRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

interface EntityListPreviewOptions extends UseEntityPreviewOptions {
  /** Override the list entity, or use each row's entityType when null. */
  entity?: Entity | null;
}

function fixedPreviewEntity(
  listEntity: Entity,
  options: EntityListPreviewOptions | undefined,
): Entity | undefined {
  if (!options || options.entity === null) return undefined;
  return options.entity ?? listEntity;
}

// Router search also carries typed dialog and pagination state, not just filters.
const routeSearchSchema = z.record(z.string(), z.json().optional());

/**
 * Server-backed tree presentation. Filtering and pagination remain manual, so
 * `filterFromLeafRows` and `paginateExpandedRows` would be inert here.
 */
export interface EntityListTreeConfig<TData, TRow> {
  /**
   * Maps flat server rows to table rows and must be referentially stable. The
   * two row types differ when foreign-entity children are nested under a row.
   */
  nest: (rows: TRow[]) => TData[];
  getSubRows: (row: TData) => TData[] | undefined;
  expandable?: boolean;
  rowLink?: RowLinkResolver<TData>;
  /**
   * Whether a row is an instance of the table's own `entity`. Required when
   * child rows are a foreign entity, and false for those children.
   *
   * Every mutation this hook wires — bulk delete, the row menu's Delete —
   * targets `entity`, so a foreign child handed to one goes to the wrong
   * endpoint under an id that entity never minted. Rather than trust each
   * caller to remember that twice, one predicate turns OFF both selection and
   * the row-action menu for those rows. Their own affordances live on their
   * own detail page, one click away through `rowLink`.
   */
  rowIsEntity?: (row: TData) => boolean;
  /**
   * Unique table row key, when `id` alone is not unique across depths.
   *
   * `getRowId` below defaults to `row.id`, which is right for a flat list and
   * for a tree whose children are foreign entities. It is WRONG when the same
   * entity can appear at two depths — a kit's component is a Product that may
   * sit in several kits and also have its own top-level row, so `id` would
   * collide and those rows would share expansion, selection, and React keys.
   *
   * Supplying this keeps `id` meaning "the entity's real shortcode" — so every
   * link, mutation, and row action can go on using it — while TanStack gets a
   * distinct key. The alternative (namespacing `id` itself) silently poisons
   * every `row.id` read in the table, which is a bug the type system cannot
   * catch: a branded shortcode's *input* type is a plain string, so a
   * namespaced id assigns cleanly into every mutation.
   */
  rowKey?: (row: TData) => string;
}

export interface UseEntityListOptions<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow = TData,
> {
  entity: BrowserRoutedEntity;
  /** The descriptor-bound plan that supplies this table's exact row type. */
  queryOptions: ListQueryOptionsFn<TFilters, TRow>;
  buildFilters?: (tableState: TableStateReturn) => TFilters;
  /**
   * Contextual scope imposed by the surrounding page (for example, expenses
   * belonging to the displayed purchase). Saved views and top-level presets
   * must use ordinary manifest-backed filter state instead. Merged over the
   * manifest-derived filters. MUST be referentially stable.
   */
  scopeFilters?: Partial<TFilters>;
  columns: CubbyColumnCollection<TData>;
  filters?: FilterInput[];
  /** Runtime roster options; must be referentially stable. */
  filterOptions?: RuntimeFilterOptions;
  getMappings?: (item: TRow) => UnitMapping[];
  tableStateOptions?: Parameters<typeof useTableState>[0];
  bulkActions?: BulkActionsConfig<TData>;
  /** Presentation-only Inspect action for one checked canonical row. */
  onInspectRow?: (row: { id?: string; original: TData }) => void;
  /** Canonical preview behavior for a top-level roster. */
  preview?: EntityListPreviewOptions;
  /** False for embedded specialist tables with their own contextual actions. */
  includeCatalogActions?: boolean;
  /** False for a scoped relation grid: no checkbox column or bulk bar, row menu kept. */
  selectable?: boolean;
  extraActions?: (row: TData) => ReactNode;
  /**
   * What each row is *about*, when that is a different record — an inventory
   * entry is about its product. That entity's actions then appear in the row
   * menu, so a verb registered once is reachable from every table that names
   * its subject rather than only from the subject's own list.
   */
  subject?: {
    entity: Entity;
    resolve: (row: TData) => EntityActionSubject | null;
  };
  initialColumnVisibility?: Record<string, boolean>;
  nameClassName?: string;
  /** Inline-edit callbacks must be referentially stable. */
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
    getValue?: (row: TData) => string | null;
  };
  nameSuffix?: (row: TData) => ReactNode;
  namePrefix?: (row: TData) => ReactNode;
  hiddenFilterColumns?: string[];
  groupConfig?: GroupConfig<TData>;
  tree?: EntityListTreeConfig<TData, TRow>;
  /**
   * Delete affordances (row menu, bulk action, confirm dialog).
   *
   * `true` uses the entity's own contract delete — its `mutation.delete`, its
   * base invalidation fan-out, and its registry label — which is what a
   * top-level list page wants (`EntityListPage` passes it by default). Omitted
   * still means NO delete: the embedded relationship ledgers rely on that,
   * since deleting a purchase out of a vendor's ledger is not what that row's
   * menu should offer. Pass a config for an entity whose contract has no
   * delete (image) or a page that needs different copy.
   */
  deletable?: DeletableConfig | true;
  deleteEmptyLabel?: (row: TData) => string;
}

export interface UseEntityListReturn<
  TData extends BaseListRow,
  TFilters extends object = object,
  TRow = TData,
> {
  workbench: ServerListWorkbenchModel<TData>;
  currentFilters: TFilters;
  mappingsMap: Record<string, UnitMapping[]>;
  data: TRow[];
  requestDelete: (item: TData) => void;
  totalCount: number | undefined;
  inspection: ReturnType<typeof useEntityPreview>;
}

type FlatEntityListOptions<
  TData extends BaseListRow,
  TFilters extends object,
> = Omit<UseEntityListOptions<TData, TFilters, TData>, "tree"> & {
  tree?: undefined;
};

type TreeEntityListOptions<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow,
> = Omit<UseEntityListOptions<TData, TFilters, TRow>, "tree"> & {
  tree: EntityListTreeConfig<TData, TRow>;
};

function entityListDocumentTitle(
  entity: BrowserRoutedEntity,
  routeSearch: z.infer<typeof routeSearchSchema>,
  syncsUrl: boolean,
) {
  if (!syncsUrl) return undefined;
  return [
    entities[entity].pluralLabel,
    summarizeListState(getEntityFilters(entity), routeSearch),
  ]
    .filter(Boolean)
    .join(": ");
}

function worklistColumnPresentation(
  worklist: ReturnType<typeof problemWorklistState>,
) {
  if (!worklist?.exact || worklist.query.source.kind !== "entity") {
    return {};
  }
  return {
    transientColumnVisibility: worklist.query.source.columnVisibility,
    revealColumns: {
      key: worklist.query.key,
      visibility: worklist.query.source.columnVisibility ?? {},
    },
  };
}

function buildMappingsMap<TRow extends BaseListRow>(
  data: TRow[],
  getMappings: ((item: TRow) => UnitMapping[]) | undefined,
  hasUnitMappings: boolean,
) {
  if (!getMappings || !hasUnitMappings) return {};
  return Object.fromEntries(
    data.map((item) => [item.id, getMappings(item)] as const),
  );
}

export function useEntityList<
  TData extends BaseListRow,
  TFilters extends object,
>(
  options: FlatEntityListOptions<TData, TFilters>,
): UseEntityListReturn<TData, TFilters, TData>;
export function useEntityList<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends BaseListRow,
>(
  options: TreeEntityListOptions<TData, TFilters, TRow>,
): UseEntityListReturn<TData, TFilters, TRow>;

export function useEntityList<
  TData extends BaseListRow,
  TFilters extends object,
  TRow extends TData = TData,
>({
  entity,
  queryOptions,
  buildFilters,
  scopeFilters,
  columns: customColumns,
  filters,
  filterOptions,
  getMappings,
  tableStateOptions,
  bulkActions,
  onInspectRow,
  preview: previewOptions,
  includeCatalogActions,
  selectable,
  extraActions,
  deletable,
  deleteEmptyLabel,
  initialColumnVisibility,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  hiddenFilterColumns,
  groupConfig,
  tree,
  subject,
}: UseEntityListOptions<TData, TFilters, TRow>): UseEntityListReturn<
  TData,
  TFilters,
  TRow
> {
  const [grouped, setGrouped] = useState(false);
  const inspection = useEntityPreview(
    fixedPreviewEntity(entity, previewOptions),
    previewOptions,
  );
  const effectiveOnInspectRow =
    onInspectRow ?? (previewOptions ? inspection.inspectRow : undefined);

  const onGroupedChange = useCallback((value: boolean) => {
    setGrouped(value);
  }, []);

  const effectiveDeletable = useContractDeletable(entity, deletable);

  const groupByField = grouped ? groupConfig?.field : undefined;

  const hasUnitMappings =
    browserEntityDefinition(entity).list?.hasUnitMappings ?? false;

  // SAFETY: the manifest builder and `scopeFilters` are both typed at this
  // hook boundary as the caller's TFilters contract.
  const manifestBuildFilters = useCallback(
    (ts: TableStateReturn) => {
      const resolvedFilters = {
        ...buildFiltersFromManifest(
          getEntityFilters(entity),
          // `allFilters`, not `columnFilters` — a URL-only scope (`?productId=`)
          // never enters the table's state, but still has to reach the server.
          // Reads raw state rather than `getColumnFilter`, which deliberately
          // throws on an array — the builder is the one caller that handles
          // both shapes, per each spec's `kind`.
          filterGetterFromColumnFilters(ts.allFilters),
        ),
        ...scopeFilters,
      };
      const primarySearch = entityInspectorMetadata[entity].primarySearch;
      if (primarySearch) {
        const primaryValue = ts.getColumnFilter(primarySearch.key);
        if (primaryValue !== undefined) {
          Object.assign(resolvedFilters, {
            [primarySearch.key]: primaryValue,
          });
        }
      }
      // SAFETY: generated field filters, generated primary search metadata, and
      // caller-owned scope filters are the three declared pieces of TFilters.
      return resolvedFilters as TFilters;
    },
    [entity, scopeFilters],
  );

  const effectiveBuildFilters = buildFilters ?? manifestBuildFilters;
  const serverTableStateOptions = useMemo(
    () => ({ syncPaginationToUrl: false, ...tableStateOptions }),
    [tableStateOptions],
  );

  const presentationState = useEntityListPresentationState<TData>({
    entity,
    tableStateOptions: serverTableStateOptions,
    deletable: effectiveDeletable,
    extraActions,
    bulkActions,
    onInspectRow: effectiveOnInspectRow,
    includeCatalogActions,
    selectable,
    deleteEmptyLabel,
    selectionScope: effectiveBuildFilters,
  });
  const { tableState } = presentationState;

  // SAFETY: presentation state receives `effectiveBuildFilters`, whose return
  // contract is TFilters, and returns that same selection scope.
  const currentFilters = presentationState.currentSelectionScope as TFilters;

  const routeSearch = routeSearchSchema.parse(useSearch({ strict: false }));
  const worklistKey = z
    .string()
    .optional()
    .safeParse(routeSearch.worklist).data;
  const worklist = problemWorklistState(
    entity,
    worklistKey,
    tableState.columnFilters,
    tableState.sorting,
  );
  useDocumentTitle(
    entityListDocumentTitle(entity, routeSearch, presentationState.urlSync),
  );

  const infiniteResult = useInfiniteTableList<TFilters, TRow>({
    queryOptions,
    buildFilters: effectiveBuildFilters,
    tableState,
    groupBy: groupByField,
  });

  const {
    data,
    totalCount,
    sums,
    groups,
    isLoading,
    error,
    timing,
    refreshControls,
  } = infiniteResult;
  const effectiveGroupConfig = useMemo(() => {
    if (!groupConfig || !grouped || !groups) return groupConfig;
    if (entity === "product") {
      const categoryRow = z.object({
        category: z.object({ id: z.string() }).nullable().optional(),
      });
      return {
        ...groupConfig,
        groups,
        keyFn: (item: TData) =>
          categoryRow.safeParse(item).data?.category?.id ??
          PRODUCT_UNCLASSIFIED_GROUP_KEY,
      };
    }
    if (entity === "location") {
      return {
        ...groupConfig,
        groups,
        keyFn: (item: TData) =>
          groupConfig.keyFn(item) ?? LOCATION_UNSPECIFIED_GROUP_KEY,
      };
    }
    return groupConfig;
  }, [entity, groupConfig, grouped, groups]);

  const serverTotals = useMemo(
    () => ({ totalCount, sums }),
    [totalCount, sums],
  );

  const mappingsMap = useMemo(
    () => buildMappingsMap(data, getMappings, hasUnitMappings),
    [data, getMappings, hasUnitMappings],
  );

  const shouldUseMappings = hasUnitMappings && getMappings;
  const effectiveMappingsMap = shouldUseMappings ? mappingsMap : null;

  const rowActionsGuard = tree?.rowIsEntity;
  const worklistColumns = worklistColumnPresentation(worklist);
  const presentation = useEntityListPresentation<TData>({
    entity,
    data,
    columns: customColumns,
    filters,
    filterOptions,
    initialColumnVisibility,
    ...worklistColumns,
    state: presentationState,
    supportsServerSorting: true,
    mappingsMap: effectiveMappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
    nameSuffix,
    namePrefix,
    hiddenFilterColumns,
    expandable: tree?.expandable,
    rowLink: tree?.rowLink,
    subject: subject?.resolve,
    rowActionGuard: rowActionsGuard,
  });
  const {
    allColumns,
    columnVisibility,
    setColumnVisibility,
    rowContentVersion,
  } = presentation;

  // Row identity is independent of whether selection happens to be enabled.
  // Index ids transfer virtualizer measurements and row state to the wrong
  // entity when filters, sorting, or accumulated pages change.
  const treeRowKey = tree?.rowKey;
  const getRowId = useCallback(
    (row: TData) => treeRowKey?.(row) ?? row.id,
    [treeRowKey],
  );

  // Tree mode nests the accumulated rows; every other consumer above — the
  // related-preview `sourceIds`, `mappingsMap`, the select-all-matching count —
  // deliberately keeps reading the FLAT `data`, which already contains every
  // row including nested ones.
  //
  // The cast covers only the NO-tree branch, where the table renders the
  // server rows as-is: `TRow` defaults to `TData`, so the two are the same
  // type there and nothing is being reinterpreted. Only `nest` may return a
  // different row shape, and it is typed to do so.
  const tableData = useMemo(
    () => (tree ? tree.nest(data) : data),
    [data, tree],
  );

  const availableRowIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (rows: readonly TData[]) => {
      for (const row of rows) {
        if (!rowActionsGuard || rowActionsGuard(row)) ids.add(getRowId(row));
        const children = tree?.getSubRows(row);
        if (children) visit(children);
      }
    };
    visit(tableData);
    return ids;
  }, [getRowId, rowActionsGuard, tableData, tree]);
  useEffect(() => {
    presentationState.listBulkActions.onRowSelectionChange?.((current) =>
      reconcileRowSelection(current, availableRowIds),
    );
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [availableRowIds, presentationState.listBulkActions.onRowSelectionChange]);

  const treeTableOptions = tree
    ? {
        getSubRows: tree.getSubRows,
        // Rows churn on every infinite-scroll page and on every mutation
        // refetch; TanStack's default would collapse the user's expanded rows.
        autoResetExpanded: false,
      }
    : undefined;
  const table = useTableConfig({
    data: tableData,
    columns: allColumns,
    tableState,
    totalCount: tableData.length,
    manualPagination: true,
    ...treeTableOptions,
    getRowId,
    enableRowSelection: rowActionsGuard
      ? (row) =>
          presentationState.listBulkActions.enableRowSelection &&
          rowActionsGuard(row.original)
      : presentationState.listBulkActions.enableRowSelection,
    rowSelection: presentationState.listBulkActions.rowSelection,
    onRowSelectionChange:
      presentationState.listBulkActions.onRowSelectionChange,
    columnVisibility,
    onColumnVisibilityChange: setColumnVisibility,
    scrollRestorationId: entity,
    serverTotals,
    rowContentVersion,
  });

  // "Select all N matching": pull every remaining page into memory (bulk
  // actions need full rows, not ids), then select all.
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const handleSelectAllMatching = useCallback(async () => {
    setIsSelectingAll(true);
    try {
      // Select from the RETURNED items, not table.getRowModel(): the table
      // still holds the pre-load rows until React re-renders, so a
      // toggleAllRowsSelected here would only select the previously-loaded set.
      const allRows = await infiniteResult.infiniteScroll.loadAllPages();
      table.setRowSelection(
        Object.fromEntries(allRows.map((row) => [row.id, true])),
      );
      // loadAllPages is bounded (its safety cap); if the filtered set is
      // larger, surface that the selection is partial rather than letting a
      // bulk action silently miss rows.
      if (allRows.length < totalCount) {
        toast.warning(
          `Selected the first ${allRows.length.toLocaleString()} of ${totalCount.toLocaleString()} — too many to select at once. Narrow the filters to cover the rest.`,
        );
      }
    } finally {
      setIsSelectingAll(false);
    }
  }, [infiniteResult.infiniteScroll, table, totalCount]);

  // In tree mode the two counts below measure different things — `data.length`
  // is loaded ROWS, `totalCount` is matching ROOTS — so the "select all N
  // matching" offer simply never fires. That's the honest outcome: it would
  // otherwise promise a count the selection can't match.
  const bulkActionBar = presentationState.listBulkActions.config ? (
    <ListBulkActionBar
      table={table}
      config={presentationState.listBulkActions.config}
      state={presentationState.listBulkActions.state}
      selectAllMatching={{
        totalCount,
        loadedCount: data.length,
        onSelectAll: handleSelectAllMatching,
        isSelectingAll,
      }}
      disabled={infiniteResult.infiniteScroll.isTransitioning}
    />
  ) : null;

  return {
    workbench: {
      entity,
      table,
      isLoading,
      error,
      timing,
      bulkActionBar,
      bulkActionPreview: bulkActionPreview(
        presentationState.listBulkActions.config,
      ),
      rowActions: presentationState.listBulkActions.rowActions,
      actionDialogs: presentationState.listBulkActions.actionDialogs,
      subjectEntity: subject?.entity,
      deleteDialog: presentationState.deleteDialog,
      infiniteScroll: infiniteResult.infiniteScroll,
      refreshControls,
      grouped,
      onGroupedChange,
      groupConfig: effectiveGroupConfig,
    },
    currentFilters,
    mappingsMap,
    data,
    requestDelete: presentationState.requestDelete,
    // Withhold until the first response lands — the underlying query hooks
    // default totalCount to 0 pre-response, which would otherwise flash
    // "0 …" in the eyebrow before the real count arrives.
    totalCount: isLoading ? undefined : totalCount,
    inspection,
  };
}
