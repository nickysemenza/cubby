import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { browserEntityDefinition, entities } from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
  summarizeListState,
} from "~/entities/filters";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import type { BulkActionsConfig } from "../data-table/bulk-actions.types";
import type { RowLinkResolver } from "../data-table/columnHelpers";
import type { ServerListWorkbenchModel } from "../data-table/ListWorkbench";
import { problemWorklistState } from "../data-table/problem-worklist";
import type { CubbyColumnDef } from "../data-table/table-features";
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

// biome-ignore lint/suspicious/noExplicitAny: intentional
type AnyColumnDef<TData extends BaseListRow> = CubbyColumnDef<TData, any>;

/**
 * Expandable-tree rendering for a server-backed list.
 *
 * Presentation ONLY. The server still owns membership, ordering, totals, and
 * pagination — it just pages by tree ROOT instead of by row (see
 * repo/project/tree.ts), and `nest` reshapes the rows it returned into parents
 * and children. That's the whole difference from `useClientEntityList`'s
 * `ClientTreeConfig`, which nests rows the browser also filtered and paginated.
 *
 * Deliberately narrower than that config: `filterFromLeafRows` and
 * `paginateExpandedRows` are omitted because they're inert here — this table is
 * `manualFiltering`/`manualPagination`, so TanStack neither filters nor
 * paginates the rows they'd govern. Don't add them back by analogy.
 */
interface EntityListTreeConfig<TData, TRow> {
  /**
   * Nest the accumulated server rows before they reach the table. MUST be
   * referentially stable (module-level constant or `useMemo`d at the page).
   *
   * The input is the SERVER row and the output is the TABLE row; they differ
   * whenever a wish's candidate Products become child rows of a different
   * shape than their parent. They're the same type for a homogeneous tree
   * (sub-projects), which is why `TRow` defaults to `TData`.
   */
  nest: (rows: TRow[]) => TData[];
  getSubRows: (row: TData) => TData[] | undefined;
  expandable?: boolean;
  /**
   * Per-row detail link, when child rows are a DIFFERENT entity than the
   * parents (the wishlist nests candidate Products under a Wish). Threaded to
   * the name column and the actions menu together so they can't disagree.
   */
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
  TFilters,
  TRow extends BaseListRow = TData,
> {
  entity: BrowserRoutedEntity;
  /**
   * Transport queryOptions function. Omit it — the default is the entity's own
   * `query.list` from `getEntityContract`, which is the same procedure every
   * standard list page was naming by hand. Pass one only for a list backed by
   * a different procedure.
   */
  queryOptions?: ListQueryOptionsFn<TFilters>;
  /**
   * Build filters from table state. Omit it to derive them from the entity's
   * filter manifest, which is what every list page should do — a hand-written
   * builder is for the leftovers a manifest spec can't express.
   */
  buildFilters?: (tableState: TableStateReturn) => TFilters;
  /**
   * Contextual scope imposed by the surrounding page (for example, expenses
   * belonging to the displayed purchase). Saved views and top-level presets
   * must use ordinary manifest-backed filter state instead. Merged over the
   * manifest-derived filters. MUST be referentially stable.
   */
  scopeFilters?: Partial<TFilters>;
  columns: AnyColumnDef<TData>[];
  filters?: FilterInput[];
  /**
   * Option lists for manifest specs naming an `optionsKey` (project roster,
   * recipe tags). MUST be referentially stable.
   */
  filterOptions?: RuntimeFilterOptions;
  getMappings?: (item: TRow) => UnitMapping[];
  tableStateOptions?: Parameters<typeof useTableState>[0];
  bulkActions?: BulkActionsConfig<TData>;
  extraActions?: (row: TData) => ReactNode;
  initialColumnVisibility?: Record<string, boolean>;
  layoutKey?: string;
  legacyLayoutVisibilityKey?: string;
  legacyLayoutSizingKey?: string;
  /**
   * Width class for the standard name column. Defaults to auto (`min-w-0`),
   * which is right for dense tables. Pass a fixed width (e.g. `w-64`) on sparse
   * tables (few columns) so the name doesn't balloon under the fixed layout.
   */
  nameClassName?: string;
  /**
   * Enable inline editing on the standard name column (entities whose name
   * column is hook-prepended, e.g. products/recipes). MUST be referentially
   * stable — wrap in useMemo/useCallback at the page, or the columns memo
   * churns every render.
   */
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
  };
  nameSuffix?: (row: TData) => ReactNode;
  namePrefix?: (row: TData) => ReactNode;
  /**
   * Column ids to render with no filter control — for a page that pins that
   * column's value via `scopeFilters` (which wins over the manifest-derived
   * filters), so a header control would otherwise be interactive but inert.
   * See `useStandardColumns`' doc comment. May be a fresh array literal each
   * render — internally stabilized.
   */
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
  /**
   * Names a row in the delete confirm dialog when its `name` is null/empty.
   * Pass the same function given to `createNameColumn`'s `emptyLabel` so the
   * dialog and the table agree — otherwise the dialog falls back to the raw
   * id, which tells the user nothing about what they're deleting.
   */
  deleteEmptyLabel?: (row: TData) => string;
}

export interface UseEntityListReturn<
  TData extends BaseListRow,
  TFilters = unknown,
  TRow = TData,
> {
  /** Complete page/embedded rendering model consumed by ListWorkbench. */
  workbench: ServerListWorkbenchModel<TData>;
  /**
   * The filter object the list query is running with (manifest-derived state
   * plus `scopeFilters`). For a page that must call a second procedure over
   * the SAME filtered set — the expenses ledger's totals row — so it can't
   * drift from the table's own.
   */
  currentFilters: TFilters;
  mappingsMap: Record<string, UnitMapping[]>;
  /**
   * Raw data array (for edge cases like card view). Always FLAT — in tree mode
   * this is every loaded row, parents and children alike, not the nested shape
   * the table renders.
   */
  data: TRow[];
  /** Opens the delete confirmation for one item (e.g. mobile swipe actions) */
  requestDelete: (item: TData) => void;
  /**
   * The true server-side filtered total — in infinite mode this is the
   * server total, NOT the number of rows loaded/accumulated so far (`data.length`).
   * `undefined` while the first page is loading (the underlying query hooks
   * default totalCount to 0 pre-response, which would otherwise flash "0 …"
   * in the eyebrow). Feed straight to `usePageCount` for the eyebrow record
   * count.
   */
  totalCount: number | undefined;
}

export function useEntityList<
  TData extends BaseListRow,
  TFilters,
  TRow extends BaseListRow = TData,
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
  extraActions,
  deletable,
  deleteEmptyLabel,
  initialColumnVisibility,
  layoutKey,
  legacyLayoutVisibilityKey,
  legacyLayoutSizingKey,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  hiddenFilterColumns,
  groupConfig,
  tree,
}: UseEntityListOptions<TData, TFilters, TRow>): UseEntityListReturn<
  TData,
  TFilters,
  TRow
> {
  const [grouped, setGrouped] = useState(false);

  const onGroupedChange = useCallback((value: boolean) => {
    setGrouped(value);
  }, []);

  // Contract-resolved defaults for the two arguments every standard list page
  // used to restate. Both are built from module-level constants plus the
  // context-stable tRPC proxy, so they never churn `usePaginatedTableCore`'s
  // `memoizedQueryOptions` or `useOptimisticDelete`'s options memo.
  const api = useTRPC();
  const contractList = getEntityContract(entity).query.list;
  const defaultQueryOptions = useCallback(
    (params: Parameters<ListQueryOptionsFn<TFilters>>[0]) =>
      contractList?.(api, params as never),
    [api, contractList],
  );
  const effectiveQueryOptions = queryOptions ?? defaultQueryOptions;
  const effectiveDeletable = useContractDeletable(entity, deletable);

  // Derive the groupBy field for server queries (only when grouped + groupConfig)
  const groupByField = grouped && groupConfig ? groupConfig.field : undefined;

  const hasUnitMappings =
    browserEntityDefinition(entity).list?.hasUnitMappings ?? false;

  // Column-filter state → the server's `*Filters` object, driven by the
  // entity's manifest. This replaced a hand-written `buildFilters` on every
  // list page, all of which were the same mechanical column-id → field map.
  // A page may still pass its own for anything a spec can't express.
  const manifestBuildFilters = useCallback(
    (ts: TableStateReturn) =>
      ({
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
      }) as TFilters,
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
    deleteEmptyLabel,
    selectionScope: effectiveBuildFilters,
  });
  const { tableState } = presentationState;

  // The exact filter object the list query runs with. Returned so a page
  // needing the same set (the expenses ledger's totals row calls
  // `expense.analytics` with it) reads it rather than rebuilding it from
  // table state — two builds that disagree by so much as a scalar-vs-array
  // shape open a second React Query cache entry for identical results.
  const currentFilters = presentationState.currentSelectionScope as TFilters;

  // `worklist` is orientation only: exact matches reveal explanatory columns
  // but never change the ordinary URL-derived membership.
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const worklist = problemWorklistState(
    entity,
    routeSearch.worklist,
    tableState.columnFilters,
    tableState.sorting,
  );
  useDocumentTitle(
    presentationState.urlSync
      ? [
          entities[entity].pluralLabel,
          summarizeListState(getEntityFilters(entity), routeSearch),
        ]
          .filter(Boolean)
          .join(": ")
      : undefined,
  );

  const infiniteResult = useInfiniteTableList<TFilters, TRow>({
    queryOptions: effectiveQueryOptions,
    buildFilters: effectiveBuildFilters,
    tableState,
    groupBy: groupByField,
  });

  const { data, totalCount, sums, isLoading, error, timing, refreshControls } =
    infiniteResult;

  // Full-filtered-set totals for footer renderers — client rows only cover
  // the loaded pages, so footers must not sum/count them.
  const serverTotals = useMemo(
    () => ({ totalCount, sums }),
    [totalCount, sums],
  );

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

  const rowActionsGuard = tree?.rowIsEntity;
  const presentation = useEntityListPresentation<TData>({
    entity,
    data,
    columns: customColumns,
    filters,
    filterOptions,
    initialColumnVisibility,
    transientColumnVisibility:
      worklist?.exact && worklist.query.source.kind === "entity"
        ? worklist.query.source.columnVisibility
        : undefined,
    revealColumns:
      worklist?.exact && worklist.query.source.kind === "entity"
        ? {
            key: worklist.query.key,
            visibility: worklist.query.source.columnVisibility ?? {},
          }
        : undefined,
    layoutKey,
    legacyLayoutVisibilityKey,
    legacyLayoutSizingKey,
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
    rowActionGuard: rowActionsGuard,
  });
  const {
    allColumns,
    layout,
    initialColumnVisibility: mergedInitialColumnVisibility,
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
    () => (tree ? tree.nest(data) : (data as unknown as TData[])),
    [data, tree],
  );

  // Feed all accumulated rows as a single "page" so TanStack Table doesn't
  // try to paginate the infinite result.
  const table = useTableConfig({
    data: tableData,
    columns: allColumns,
    tableState,
    totalCount: tableData.length,
    manualPagination: true,
    ...(tree
      ? {
          getSubRows: tree.getSubRows,
          // Rows churn on every infinite-scroll page and on every mutation
          // refetch; TanStack's default would collapse the user's expanded
          // rows each time.
          autoResetExpanded: false,
        }
      : {}),
    getRowId,
    enableRowSelection: rowActionsGuard
      ? (row) =>
          presentationState.listBulkActions.enableRowSelection &&
          rowActionsGuard(row.original)
      : presentationState.listBulkActions.enableRowSelection,
    rowSelection: presentationState.listBulkActions.rowSelection,
    onRowSelectionChange:
      presentationState.listBulkActions.onRowSelectionChange,
    initialColumnVisibility: mergedInitialColumnVisibility,
    layout,
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

  // Build bulk action bar element if bulk actions configured.
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
      deleteDialog: presentationState.deleteDialog,
      infiniteScroll: infiniteResult.infiniteScroll,
      refreshControls,
      grouped,
      onGroupedChange,
      groupConfig,
    },
    currentFilters,
    mappingsMap,
    data,
    requestDelete: presentationState.requestDelete,
    // Withhold until the first response lands — the underlying query hooks
    // default totalCount to 0 pre-response, which would otherwise flash
    // "0 …" in the eyebrow before the real count arrives.
    totalCount: isLoading ? undefined : totalCount,
  };
}
