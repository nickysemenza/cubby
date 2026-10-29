import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  ListGroupBy,
  ListGroupSummary,
  ListNesting,
  ListResultMembership,
} from "@cubby/schemas/pagination";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { constructRow } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { browserEntityDefinition, entities } from "~/entity/entities";
import type { ListReadProjection } from "~/entity/entity-list/list-read-demand";
import {
  getEntityFilters,
  manifestFilterFields,
  menuOnlyFilterSpecs,
} from "~/entity/filter-manifest";
import {
  buildFiltersFromManifest,
  FILTER_EXACT,
  FILTER_NONE,
  filterGetterFromColumnFilters,
  hideSectionValues,
  summarizeListState,
} from "~/entity/filters";
import { listEntities } from "~/entity/generated/entity-lists.gen";
import { loadSelectionRecords } from "~/entity/hooks/selection-records";
import { useDeferredReferenceFilterOptions } from "~/entity/hooks/use-deferred-reference-filter-options";
import { useInfiniteTableList } from "~/entity/hooks/use-infinite-table-list";
import { useEntityMetadata } from "~/entity/metadata";
import { useProblemContinuation } from "~/entity/problems/problem-continuation";
import type { RowLinkResolver } from "~/entity/table/column-helpers";
import type { ServerListWorkbenchModel } from "~/entity/table/list-workbench";
import { problemWorklistState } from "~/entity/table/problem-worklist";
import type {
  TableStateReturn,
  useTableState,
} from "~/entity/table/use-table-state";
import { entityList } from "~/integrations/tanstack-query/generated/domains/entityList.gen";
import { formatCount } from "~/lib/number-format";
import { CurrencyValue } from "~/ui/common/currency-value";
import {
  bulkActionPreview,
  type BulkActionsConfig,
} from "~/ui/data-table/bulk-actions.types";
import { reconcileRowSelection } from "~/ui/data-table/row-selection";
import type { CubbyColumnCollection } from "~/ui/data-table/table-features";
import type { GroupConfig } from "~/ui/data-table/use-grouped-list";
import { useTableConfig } from "~/ui/data-table/use-table-config";
import { showErrorToast } from "~/ui/feedback/error-details";
import type { RuntimeFilterOptions } from "~/ui/hooks/filter-option-types";
import { useDocumentTitle } from "~/ui/hooks/use-document-title";
import type { ListQueryOptionsFn } from "~/ui/hooks/use-paginated-table-core";
import {
  serverTreeRowCanExpand,
  type ServerTreeRow,
  serverTreeStatusOf,
  useServerTreeChildren,
} from "~/ui/hooks/use-server-tree-children";

import { type EntityActionSubject } from "../actions/entity-actions";
import {
  type DeletableConfig,
  useContractDeletable,
} from "./use-deletable-config";
import {
  useEntityListPresentation,
  useEntityListPresentationState,
  useEntityListColumnVisibility,
} from "./use-entity-list-presentation";
import {
  useEntityPreview,
  type UseEntityPreviewOptions,
} from "./use-entity-preview";
import { ListBulkActionBar } from "./use-list-bulk-actions";
import type { FilterInput } from "./use-standard-columns";

export interface BaseListRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  images?: Array<{ id: string; url: string; filename: string }>;
}

interface EntityListPreviewOptions extends UseEntityPreviewOptions {
  /** Override the list entity, or use each row's entityKind when null. */
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
const ROOTS_SCOPE: ListNesting = { scope: "roots" };
const isServerTreeRecord = (row: { id: string }) => !serverTreeStatusOf(row);
const serverTreeRowOffersExpansion = (row: { original: unknown }) =>
  serverTreeRowCanExpand(row.original);
// SAFETY: a server tree's table rows are exactly `attach`'s output.
const serverTreeSubRows = <T,>(row: T): T[] | undefined =>
  (row as ServerTreeRow<T>).subRows;

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
  /** An honest selected-row adapter; selection action reloads retain queryOptions. */
  selectedQueryOptions?: ListQueryOptionsFn<TFilters, TRow>;
  readProjection?: ListReadProjection | null;
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
  /**
   * What each row is *about*, when that is a different record — an inventory
   * entry is about its product. That entity's actions then appear in the row
   * menu, so a verb registered once is reachable from every table that names
   * its subject rather than only from the subject's own list.
   */
  subject?: {
    entity: Entity;
    readFields?: readonly string[];
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
  /**
   * The active `model.grouping` choice. A key with a reason, or none the
   * entity declares, leaves the list flat.
   */
  groupBy?: ListGroupBy[];
  /**
   * Lets column header menus switch `groupBy` (null ungroups). Omit to keep
   * grouping fixed by the caller.
   */
  onGroupByChange?: (key: string | null) => void;
  tree?: EntityListTreeConfig<TData, TRow>;
  /**
   * Nest under the entity's declared `list.tree` on the server: page the
   * roots and read each expanded row's children. Exclusive with `tree`.
   */
  serverTree?: boolean;
  /** The nested/flat switch a `list.tree.toggle` entity offers. */
  nestToggle?: ServerListWorkbenchModel<TData>["nestToggle"];
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
  unresolvedCount: number | undefined;
  resultMembership: ListResultMembership;
  setResultMembership: (membership: ListResultMembership) => void;
  sums: Record<string, number> | undefined;
  totalLabels: Record<string, string> | undefined;
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
  queryClient: QueryClient,
  entity: BrowserRoutedEntity,
  routeSearch: z.infer<typeof routeSearchSchema>,
  syncsUrl: boolean,
) {
  if (!syncsUrl) return undefined;
  return [
    entities[entity].pluralLabel,
    summarizeListState(getEntityFilters(queryClient, entity), routeSearch),
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

function listReadColumnId(column: { id?: string }): string {
  if (column.id) return column.id;
  const accessor =
    "accessorKey" in column
      ? z.string().safeParse(column.accessorKey)
      : undefined;
  return accessor?.success ? accessor.data : "";
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
  selectedQueryOptions,
  readProjection,
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
  deletable,
  deleteEmptyLabel,
  initialColumnVisibility,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  hiddenFilterColumns,
  groupBy,
  onGroupByChange,
  tree,
  serverTree = false,
  nestToggle,
  subject,
}: UseEntityListOptions<TData, TFilters, TRow>): UseEntityListReturn<
  TData,
  TFilters,
  TRow
> {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const routeSearch = routeSearchSchema.parse(useSearch({ strict: false }));
  const groupChoice = groupBy
    ? metadata.listFields.grouping.find(
        (choice) => choice.key === groupBy[0]?.key && choice.reason === null,
      )
    : undefined;
  const tableGrouping = useMemo(
    () =>
      onGroupByChange && {
        choices: metadata.listFields.grouping.flatMap((choice) =>
          choice.reason === null && choice.filter
            ? [
                {
                  key: choice.key,
                  columnId: choice.filter.columnId,
                  label: choice.label,
                },
              ]
            : [],
        ),
        active: groupChoice?.key ?? null,
        onChange: onGroupByChange,
      },
    [metadata, groupChoice?.key, onGroupByChange],
  );
  const inspection = useEntityPreview(
    fixedPreviewEntity(entity, previewOptions),
    previewOptions,
  );
  const effectiveOnInspectRow =
    onInspectRow ?? (previewOptions ? inspection.inspectRow : undefined);

  const effectiveDeletable = useContractDeletable(entity, deletable);
  // Every reference filter loads its live roster here, so an embedded list
  // (Linked transactions) offers pickers without wiring rosters itself.
  // A caller's own `filterOptions` win.
  const referenceFilterOptions = useDeferredReferenceFilterOptions(entity);
  const resolvedFilterOptions = useMemo(
    () =>
      filterOptions
        ? { ...referenceFilterOptions, ...filterOptions }
        : referenceFilterOptions,
    [filterOptions, referenceFilterOptions],
  );

  const hasUnitMappings =
    browserEntityDefinition(entity).list?.hasUnitMappings ?? false;

  // SAFETY: the manifest builder and `scopeFilters` are both typed at this
  // hook boundary as the caller's TFilters contract.
  const manifestBuildFilters = useCallback(
    (ts: TableStateReturn) => {
      const resolvedFilters = {
        ...buildFiltersFromManifest(
          getEntityFilters(queryClient, entity),
          // Reads raw state rather than `getColumnFilter`, which deliberately
          // throws on an array — the builder is the one caller that handles
          // both shapes, per each spec's `kind`.
          filterGetterFromColumnFilters(ts.columnFilters),
        ),
        ...scopeFilters,
      };
      const primarySearch = metadata.summary.primarySearch;
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
    [entity, queryClient, metadata, scopeFilters],
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

  const worklistKey = z
    .string()
    .optional()
    .safeParse(routeSearch.worklist).data;
  const worklist = problemWorklistState(
    entity,
    useProblemContinuation(worklistKey),
    tableState.columnFilters,
    tableState.sorting,
  );
  useDocumentTitle(
    entityListDocumentTitle(
      queryClient,
      entity,
      routeSearch,
      presentationState.urlSync,
    ),
  );

  const worklistColumns = worklistColumnPresentation(worklist);
  const visibility = useEntityListColumnVisibility({
    entity,
    initialColumnVisibility,
    ...worklistColumns,
  });
  const requestedFields = useMemo(
    () => readProjection?.(queryClient, entity, visibility.columnVisibility),
    [entity, queryClient, readProjection, visibility.columnVisibility],
  );
  const pageQueryOptions = useMemo(
    (): ListQueryOptionsFn<TFilters, TRow> =>
      requestedFields && selectedQueryOptions
        ? (params) =>
            selectedQueryOptions({ ...params, fields: requestedFields })
        : queryOptions,
    [queryOptions, requestedFields, selectedQueryOptions],
  );
  const [resultMembership, setResultMembership] =
    useState<ListResultMembership>("known");
  const infiniteResult = useInfiniteTableList<TFilters, TRow>({
    queryOptions: pageQueryOptions,
    requiredFields: requestedFields,
    buildFilters: effectiveBuildFilters,
    tableState,
    groupBy,
    nesting: serverTree ? ROOTS_SCOPE : undefined,
    resultMembership,
    includeCount: Boolean(subject || scopeFilters),
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
  const { setColumnFilters } = tableState;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const groupConfig = useMemo((): GroupConfig | undefined => {
    if (!groupChoice || !groups) return undefined;
    const fields = getEntityFilters(queryClient, entity);
    const sectionFilter = (
      group: ListGroupSummary,
      depth = group.path.length - 1,
    ) => {
      const dimension = groupBy?.[depth];
      const choice = metadata.listFields.grouping.find(
        (entry) => entry.key === dimension?.key,
      );
      const filter = dimension?.bucket ? null : choice?.filter;
      const spec = filter
        ? fields.find((entry) => entry.columnId === filter.columnId)
        : undefined;
      const key = group.path[depth];
      return filter &&
        spec &&
        key !== undefined &&
        (key !== FILTER_NONE || filter.noValue)
        ? { filter, spec, key }
        : undefined;
    };
    const canFilter = (group: ListGroupSummary) =>
      group.path.every((_, depth) => sectionFilter(group, depth) !== undefined);
    return {
      choice: groupChoice,
      groups,
      memberships: infiniteResult.memberships ?? [],
      collapsed: new Set(
        groups
          .filter((group) =>
            collapsedGroups.has(JSON.stringify([entity, groupBy, group.key])),
          )
          .map((group) => group.key),
      ),
      onToggle: (key) =>
        setCollapsedGroups((previous) => {
          const identity = JSON.stringify([entity, groupBy, key]);
          const next = new Set(previous);
          if (next.has(identity)) next.delete(identity);
          else next.add(identity);
          return next;
        }),
      canFilter,
      onFilter: (group) => {
        if (!canFilter(group)) return;
        setColumnFilters((previous) => {
          let next = previous;
          group.path.forEach((_, depth) => {
            const field = sectionFilter(group, depth);
            if (!field) return;
            const summary = groups.find(
              (entry) =>
                entry.key === JSON.stringify(group.path.slice(0, depth + 1)),
            );
            next = [
              ...next.filter(({ id }) => id !== field.filter.columnId),
              {
                id: field.filter.columnId,
                value:
                  field.spec.subtree && !summary?.subtree
                    ? [field.key, FILTER_EXACT]
                    : [field.key],
              },
            ];
          });
          return next;
        });
      },
      // Flat Exclude filters cannot hide just one nested path without also
      // hiding its value under other parents. Keep Hide at the root scope.
      hide: (group) => {
        if (group.path.length !== 1) return undefined;
        const field = sectionFilter(group);
        if (!field) return undefined;
        const valueGroup = { ...group, key: field.key };
        if (hideSectionValues(field.spec, valueGroup, []) === undefined)
          return undefined;
        return () =>
          setColumnFilters((previous) => {
            const current = previous.find(
              ({ id }) => id === field.spec.columnId,
            )?.value;
            const values = hideSectionValues(
              field.spec,
              valueGroup,
              Array.isArray(current) ? current.map(String) : [],
            );
            return [
              ...previous.filter(({ id }) => id !== field.spec.columnId),
              ...(values?.length
                ? [{ id: field.spec.columnId, value: values }]
                : []),
            ];
          });
      },
      header: (group) => ({
        aside: (
          <>
            {group.overlapping && (
              <span
                className="text-xs text-muted-foreground"
                title="Records may occur in more than one group. Overall totals count each record once."
              >
                Overlapping
              </span>
            )}
            {group.fraction !== null && (
              <span
                className="text-xs text-muted-foreground"
                title={`${group.count} of ${group.parentCount} records ${group.path.length > 1 ? "in the parent group" : "matching the filters"}`}
              >
                {Math.round(group.fraction * 100)}% of records
              </span>
            )}
            {metadata.listFields.metrics.map((metric) => {
              const value = group.metrics?.[metric.key];
              if (!value) return null;
              return (
                <span
                  key={metric.key}
                  className="inline-flex items-center gap-1 text-xs"
                  title={`${metric.label}: ${value.presentCount} of ${value.totalCount} records have a value`}
                >
                  <span className="text-muted-foreground">{metric.label}</span>
                  {value.sum === null ? (
                    "–"
                  ) : metric.format === "currency" ||
                    metric.format === "signedCurrency" ? (
                    <CurrencyValue
                      value={value.sum}
                      interactive={false}
                      tone={false}
                    />
                  ) : (
                    formatCount(value.sum)
                  )}
                  {value.coverage !== null && value.coverage < 1 && (
                    <span className="text-muted-foreground">partial</span>
                  )}
                </span>
              );
            })}
          </>
        ),
      }),
    };
  }, [
    entity,
    groupChoice,
    groups,
    setColumnFilters,
    collapsedGroups,
    groupBy,
    infiniteResult.memberships,
    queryClient,
    metadata,
  ]);

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

  // Columns key on `subject`; an inline resolver was a new function every
  // render, so each list render rebuilt every column and remounted every cell.
  // Cells call it while rendering, so it reads the latest resolver from a ref.
  const resolveSubject = useRef<
    ((row: TData) => EntityActionSubject | null) | null
  >(null);
  resolveSubject.current = subject
    ? (row: TData) => subject.resolve(row)
    : null;
  const stableSubject = useCallback(
    (row: TData) => resolveSubject.current?.(row) ?? null,
    [],
  );

  // A server tree's status row (loading, error, Load more) is no record.
  const rowActionsGuard =
    tree?.rowIsEntity ?? (serverTree ? isServerTreeRecord : undefined);
  const presentation = useEntityListPresentation<TData>({
    entity,
    data,
    columns: customColumns,
    filters,
    filterOptions: resolvedFilterOptions,
    visibility,
    state: presentationState,
    supportsServerSorting: true,
    mappingsMap: effectiveMappingsMap,
    hasUnitMappings,
    nameClassName,
    nameEditable,
    nameSuffix,
    namePrefix,
    hiddenFilterColumns,
    expandable: tree?.expandable ?? serverTree,
    rowLink: tree?.rowLink,
    subject: subject ? stableSubject : undefined,
    rowActionGuard: rowActionsGuard,
  });
  const {
    allColumns,
    columnVisibility,
    setColumnVisibility,
    rowContentVersion,
  } = presentation;

  // A declared filter no column hosts (a relation scope such as expenses'
  // `productId`) still gets a Filters-menu field. A scope the caller fixes
  // or hides stays out, as does the primary search, which has its own input.
  const scopeKeys = Object.keys(scopeFilters ?? {}).join("|");
  const hiddenFilterKey = (hiddenFilterColumns ?? []).join("|");
  const activeKey = tableState.columnFilters
    .map((filter) => filter.id)
    .join("|");
  const filterFields = useMemo(() => {
    const specs = getEntityFilters(queryClient, entity);
    const menu = new Set(
      menuOnlyFilterSpecs(specs, {
        hostedIds: new Set(allColumns.visit(listReadColumnId)),
        excludedKeys: new Set([
          ...scopeKeys.split("|"),
          ...hiddenFilterKey.split("|"),
          metadata.summary.primarySearch?.key,
        ]),
        activeIds: new Set(activeKey.split("|")),
      }),
    );
    return manifestFilterFields(specs, resolvedFilterOptions, (spec) =>
      menu.has(spec),
    );
  }, [
    activeKey,
    allColumns,
    entity,
    hiddenFilterKey,
    resolvedFilterOptions,
    scopeKeys,
    queryClient,
    metadata,
  ]);

  // Row identity is independent of whether selection happens to be enabled.
  // Index ids transfer virtualizer measurements and row state to the wrong
  // entity when filters, sorting, or accumulated pages change.
  const treeRowKey = tree?.rowKey;
  const getRowId = useCallback(
    (row: TData) => treeRowKey?.(row) ?? row.id,
    [treeRowKey],
  );

  // A server tree's children arrive per expanded parent under the list's
  // own filters and sort; the loaded root pages are never nested locally.
  const treeChildren = useServerTreeChildren<TRow>({
    enabled: serverTree,
    scope: infiniteResult.scope,
    planFor: infiniteResult.scopedPlan,
  });
  // A module tree maps the accumulated rows (a wish's embedded candidates);
  // every other consumer above — the related-preview `sourceIds`,
  // `mappingsMap`, the select-all-matching count — keeps reading the root
  // `data`. Only `nest` may return a different row shape, and it is typed to.
  const attachChildren = treeChildren.attach;
  const tableData = useMemo(
    (): TData[] =>
      tree ? tree.nest(data) : serverTree ? attachChildren(data) : data,
    [data, tree, serverTree, attachChildren],
  );
  const getSubRows =
    tree?.getSubRows ?? (serverTree ? serverTreeSubRows<TData> : undefined);

  const selectionScope = JSON.stringify([
    entity,
    effectiveBuildFilters(tableState),
    serverTree,
    resultMembership,
  ]);
  const liveSelectionScope = useRef(selectionScope);
  liveSelectionScope.current = selectionScope;
  const liveSelectedIds = useRef("");
  liveSelectedIds.current = JSON.stringify(
    Object.keys(presentationState.listBulkActions.state.rowSelection)
      .filter((id) => presentationState.listBulkActions.state.rowSelection[id])
      .sort(),
  );
  const selectionController = useRef<AbortController | null>(null);
  const [matchingSelection, setMatchingSelection] = useState<{
    scope: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    setMatchingSelection(null);
    return () => selectionController.current?.abort();
  }, [selectionScope]);
  const availableRowIds = useMemo(() => {
    const ids = new Set<string>();
    if (matchingSelection?.scope === selectionScope) {
      for (const id of matchingSelection.ids) ids.add(id);
    }
    const visit = (rows: readonly TData[]) => {
      for (const row of rows) {
        if (!rowActionsGuard || rowActionsGuard(row)) ids.add(getRowId(row));
        const children = getSubRows?.(row);
        if (children) visit(children);
      }
    };
    visit(tableData);
    return ids;
  }, [
    getRowId,
    getSubRows,
    rowActionsGuard,
    tableData,
    matchingSelection,
    selectionScope,
  ]);
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
    : serverTree
      ? {
          getSubRows: serverTreeSubRows<TData>,
          // Children load after expansion, so `childCount` offers the toggle.
          getRowCanExpand: serverTreeRowOffersExpansion,
          // Children arrive after expansion and pages churn; the hook owns
          // the reset (filters or sort changed), not TanStack's data reset.
          autoResetExpanded: false,
          expanded: treeChildren.expanded,
          onExpandedChange: treeChildren.onExpandedChange,
        }
      : undefined;
  const table = useTableConfig({
    valueChangeScope: selectionScope,
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
    filterFields,
    rowContentVersion,
    grouping: tableGrouping || undefined,
  });

  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const selectionEntity = listEntities.find(
    (candidate) => candidate === entity,
  );
  const handleSelectAllMatching = useCallback(async () => {
    if (!selectionEntity) return;
    const scope = selectionScope;
    const selectedAtStart = liveSelectedIds.current;
    selectionController.current?.abort();
    const controller = new AbortController();
    selectionController.current = controller;
    setIsSelectingAll(true);
    try {
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let expectedCount: number | undefined;
      do {
        const page = await entityList.selectionIds.call(
          {
            entity: selectionEntity,
            filters: z
              .record(z.string(), z.unknown())
              .parse(effectiveBuildFilters(tableState)),
            ...(serverTree ? { nesting: ROOTS_SCOPE } : {}),
            resultMembership,
            cursor,
            limit: 500,
          },
          { signal: controller.signal },
        );
        if (liveSelectionScope.current !== scope) return;
        if (expectedCount !== undefined && page.totalCount !== expectedCount)
          throw new Error(
            "The matching population changed while selecting records. Select them again.",
          );
        expectedCount = page.totalCount;
        for (const id of page.ids) {
          if (ids.has(id))
            throw new Error(
              "The matching identity pages overlap. Selection was not applied.",
            );
          ids.add(id);
        }
        if (page.nextCursor && cursors.has(page.nextCursor))
          throw new Error(
            "The selection cursor did not advance. Selection was not applied.",
          );
        if (page.nextCursor) cursors.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (liveSelectionScope.current !== scope || controller.signal.aborted)
        return;
      if (liveSelectedIds.current !== selectedAtStart)
        throw new Error(
          "Selection changed while matching records were loading. Select all matching again to apply it.",
        );
      if (ids.size !== expectedCount)
        throw new Error(
          "The complete matching selection could not be resolved. Select the records again.",
        );
      setMatchingSelection({ scope, ids });
      table.setRowSelection(
        Object.fromEntries([...ids].map((id) => [id, true])),
      );
    } catch (error) {
      if (!controller.signal.aborted) showErrorToast(error);
    } finally {
      setIsSelectingAll(false);
    }
  }, [
    selectionEntity,
    resultMembership,
    selectionScope,
    effectiveBuildFilters,
    tableState,
    serverTree,
    table,
  ]);

  const resolveSelectedRows = useCallback(
    async (ids: string[]) => {
      const scope = selectionScope;
      selectionController.current?.abort();
      const controller = new AbortController();
      selectionController.current = controller;
      const records = await loadSelectionRecords({
        ids,
        filters: effectiveBuildFilters(tableState),
        queryOptions,
        signal: controller.signal,
      });
      if (liveSelectionScope.current !== scope)
        throw new Error(
          "The list scope changed while checking the action. Select the records again.",
        );
      return records.map((record, index) =>
        constructRow(table, record.id, record, index, 0),
      );
    },
    [selectionScope, effectiveBuildFilters, tableState, queryOptions, table],
  );

  const bulkActionBar = presentationState.listBulkActions.config ? (
    <ListBulkActionBar
      table={table}
      config={presentationState.listBulkActions.config}
      state={presentationState.listBulkActions.state}
      resolveSelectedRows={resolveSelectedRows}
      selectAllMatching={
        selectionEntity && !tree && !subject && !rowActionsGuard
          ? {
              totalCount,
              hasNextPage: infiniteResult.infiniteScroll.hasNextPage,
              loadedCount: data.length,
              onSelectAll: handleSelectAllMatching,
              isSelectingAll,
            }
          : undefined
      }
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
      groupConfig,
      nestToggle,
    },
    currentFilters,
    mappingsMap,
    data,
    requestDelete: presentationState.requestDelete,
    // Withhold until the first response lands — the underlying query hooks
    // default totalCount to 0 pre-response, which would otherwise flash
    // "0 …" in the eyebrow before the real count arrives.
    totalCount: isLoading ? undefined : totalCount,
    sums,
    totalLabels: infiniteResult.totalLabels,
    unresolvedCount: infiniteResult.unresolvedCount,
    resultMembership,
    setResultMembership,
    inspection,
  };
}
