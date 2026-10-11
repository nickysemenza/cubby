import { isSlotListView } from "@cubby/schemas/entity-definitions/definition";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { entities } from "~/entity/entities";
import type { StandardEntity } from "~/entity/entity-contracts";
import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entity/entity-display";
import { entityListBaseFor } from "~/entity/entity-list";
import { identityListConfig } from "~/entity/entity-list/identity-list-config";
import { ListTotalSummary } from "~/entity/entity-list/list-total-summary";
import { SuggestionSweepAction } from "~/entity/entity-list/suggestion-sweep-action";
import {
  type ListEntity,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import { generatedBrowserCrudEntities } from "~/entity/generated/entity-routes.gen";
import {
  type TimelineEntity,
  timelineEntities,
} from "~/entity/generated/entity-timelines.gen";
import {
  assertSpecialistColumnProvenance,
  type AnyEntityListOverride,
  type EntityListOverrideResult,
  type ListOverrideContext,
  type ListOverrideWorkbenchProps,
} from "~/entity/list-columns/types";
import { getAppErrorDetails } from "~/lib/error-utils";
import {
  createImageColumn,
  isImageColumnId,
  hasDisplayImages,
} from "~/ui/data-table/columnHelpers";
import { DataTablePagination } from "~/ui/data-table/data-table-pagination";
import { DataTableToolbar } from "~/ui/data-table/data-table-toolbar";
import { ListWorkbench } from "~/ui/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { ErrorDetails } from "~/ui/feedback/error-details";
import { useClientEntityList } from "~/ui/hooks/useClientEntityList";
import { useDeferredReferenceFilterOptions } from "~/ui/hooks/useDeferredReferenceFilterOptions";
import {
  type BaseListRow,
  type EntityListTreeConfig,
  useEntityList,
  type UseEntityListReturn,
} from "~/ui/hooks/useEntityList";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";
import type { ListQueryOptionsFn } from "~/ui/hooks/usePaginatedTableCore";
import { useEntityFieldSave } from "~/ui/hooks/useUpdateMutation";
import { Stack } from "~/ui/layout";
import { usePageCount } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";

import { EntityShelf } from "./entity-shelf";
import { ListScopeChips } from "./list-scope-chips";
import {
  type ListNavigate,
  type ListSearch,
  listSearchSchema,
  type ListSlotProps,
} from "./list-slot-types";
import { listSlotFor } from "./list-slots";
import { manifestTree } from "./manifest-tree";
import { resolveListView } from "./resolve-list-view";

const EntityTimeline = lazy(() =>
  import("~/entity/timeline/entity-timeline").then((module) => ({
    default: module.EntityTimeline,
  })),
);

type CardDensity = "cards" | "compact";
const CardDensityContext = createContext<{
  density: CardDensity;
  setDensity: (density: CardDensity) => void;
} | null>(null);

/**
 * Compactness belongs to the mounted list screen, not the URL or persistence.
 * The provider is shared with the route chrome so its segmented control and
 * the card renderer change together.
 */
export function EntityListCardDensityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [density, setDensity] = useState<CardDensity>("cards");
  return (
    <CardDensityContext value={{ density, setDensity }}>
      {children}
    </CardDensityContext>
  );
}

export function useEntityListCardDensity() {
  const context = useContext(CardDensityContext);
  if (!context)
    throw new Error("EntityListCardDensityProvider is required for card lists");
  return context;
}

/* -------------------------------------------------------------------------- */
/* Search + view                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The route's search as a bag plus a merge-navigate over it. Route-agnostic
 * on purpose: this component renders on every generated index route, each
 * with its own generated schema, so a typed `useNavigate` can't fit them all.
 */
export function useListSearch(): ListSlotProps {
  const search = listSearchSchema.parse(useSearch({ strict: false }));
  const routeNavigate = useNavigate();
  const navigate = useCallback<ListNavigate>(
    (patch, options) => {
      // SAFETY: route-specific search keys are intentionally erased here;
      // every generated index route validates the keys a view writes.
      routeNavigate({
        search: (previous: ListSearch) => ({ ...previous, ...patch }),
        replace: options?.replace,
      } as never);
    },
    [routeNavigate],
  );
  return { search, navigate };
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                   */
/* -------------------------------------------------------------------------- */

const NO_OVERRIDE: AnyEntityListOverride = { use: () => ({}) };
const DEFAULT_PREVIEW = { responsiveInspector: true } as const;
const useNoWorkbenchProps = (
  _list: UseEntityListReturn<BaseListRow>,
): ListOverrideWorkbenchProps<BaseListRow> => ({});

const isListEntity = (entity: BrowserRoutedEntity): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);
const isTimelineEntity = (
  entity: BrowserRoutedEntity,
): entity is TimelineEntity =>
  timelineEntities.some((candidate) => candidate === entity);

const isStandardEntity = (
  entity: BrowserRoutedEntity,
): entity is StandardEntity =>
  generatedBrowserCrudEntities.some((candidate) => candidate === entity);

function useListColumns(
  entity: BrowserRoutedEntity,
  parts: EntityListOverrideResult<BaseListRow, object>,
  allowAutoIdentityEditing: boolean,
) {
  const helper = useMemo(() => createCubbyColumnHelper<BaseListRow>(), []);
  const { overrides, compose } = parts;
  // Cookbook has a custom client-backed list but no standard update command;
  // `useEntityFieldSave` then hands back no writer at all.
  const onSaveField = useEntityFieldSave(entity);
  const identity = useMemo(
    () =>
      identityListConfig(entity, {
        generatedCrud: isStandardEntity(entity),
        flatRows:
          allowAutoIdentityEditing &&
          !parts.tree &&
          !parts.source &&
          !parts.client,
      }),
    [allowAutoIdentityEditing, entity, parts.client, parts.source, parts.tree],
  );
  const identityEditable = useMemo(() => {
    if (!identity.canAutoEdit || parts.list?.nameEditable || !onSaveField)
      return undefined;
    return {
      // `identityListConfig` proves this is the same non-null text field in
      // the generated entity's update roster.
      onSave: (newValue: string, row: BaseListRow) =>
        onSaveField(row, identity.titleField, newValue),
    };
  }, [identity, onSaveField, parts.list?.nameEditable]);
  const columns = useMemo(() => {
    const declared = createEntityDisplayColumns(entity, helper, overrides, {
      onSaveField,
    });
    const composed = compose
      ? assertSpecialistColumnProvenance(entity, declared, compose(declared))
      : declared;
    const policy = entityManifest[entity].images;
    if (policy.storage === false && policy.displaySources.length === 0)
      return composed;
    const imageId = entityFieldModels[entity].fields.some(
      (field) => field.key === "images" && field.display.list,
    )
      ? "images"
      : "image";
    const hasImageColumn = composed
      .visit((column) => isImageColumnId(column.id))
      .some(Boolean);
    if (hasImageColumn) return composed;
    return createCubbyColumnCollection<BaseListRow>((add) => {
      add(
        createImageColumn(helper, {
          entity,
          id: imageId,
          getImages: (row) => (hasDisplayImages(row) ? row.displayImages : []),
        }),
      );
      composed.visit(add);
    });
  }, [entity, helper, overrides, compose, onSaveField]);
  // The generic column collection is kept separate from the identity adapter
  // so client/custom-source lists can still share the same column compiler.
  return { columns, identityEditable };
}

function useListInitialColumnVisibility(
  entity: BrowserRoutedEntity,
  overrides?: Record<string, boolean>,
) {
  return useMemo(
    () => ({
      ...entityListHiddenColumns(entity),
      ...overrides,
      createdAt: true,
      updatedAt: true,
    }),
    [entity, overrides],
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export interface GenericEntityListProps {
  entity: BrowserRoutedEntity;
  /** Test seam: replaces the entity's generic list read. */
  operations?: { list?: ListQueryOptionsFn<object, BaseListRow> };
  override?: AnyEntityListOverride;
}

/**
 * The one list page: rendered from `entitySummary[entity].list` over
 * `useEntityList` + `ListWorkbench`, with the entity's hand-written half
 * (`entities/list-columns/<entity>`) and slot views (`listSlots`) plugged
 * in by its route component. The view switcher and header live in `listPage`.
 */
export function GenericEntityList({
  entity,
  operations,
  override = NO_OVERRIDE,
}: GenericEntityListProps) {
  const { search, navigate } = useListSearch();
  const { view } = resolveListView(entity, search);

  if (isSlotListView(view)) {
    const Slot = listSlotFor(entity, view.id);
    return Slot ? <Slot search={search} navigate={navigate} /> : null;
  }
  if (override.mode === "client") {
    return (
      <ClientListBody
        entity={entity}
        view={view}
        override={override}
        context={{ search, navigate }}
      />
    );
  }
  return (
    <ServerListBody
      entity={entity}
      view={view}
      override={override}
      context={{ search, navigate }}
      operations={operations}
    />
  );
}

// oxlint-disable-next-line complexity -- one server list owns its shared query, inspector, and three manifest renderers so their state cannot drift.
function ServerListBody({
  entity,
  view,
  override,
  context,
  operations,
}: {
  entity: BrowserRoutedEntity;
  view: "table" | "shelf" | "timeline";
  override: AnyEntityListOverride;
  context: ListOverrideContext;
  operations: GenericEntityListProps["operations"];
}) {
  const { density } = useEntityListCardDensity();
  const overrideParts = override.use(context);
  // A module's hand-written tree (heterogeneous rows, like wish candidates)
  // wins; otherwise the manifest's declared `list.tree` nests the rows.
  const parts = overrideParts.tree
    ? overrideParts
    : { ...overrideParts, tree: manifestTree(entity) ?? undefined };
  const referenceFilterOptions = useDeferredReferenceFilterOptions(entity);
  const filterOptions = useFilterOptions({
    ...referenceFilterOptions,
    ...parts.list?.filterOptions,
  });
  // Cards and Compact keep the same query, filtering, ordering, and page as
  // List. A search changes the roster, never the chosen presentation.
  const renderedView = view;
  const { columns, identityEditable } = useListColumns(entity, parts, true);
  const listOptions = useMemo(() => {
    if (parts.list?.nameEditable || !identityEditable) return parts.list;
    return { ...parts.list, nameEditable: identityEditable };
  }, [identityEditable, parts.list]);
  const queryOptions = useMemo((): ListQueryOptionsFn<object, BaseListRow> => {
    if (operations?.list) return operations.list;
    if (parts.source) return parts.source;
    if (!isListEntity(entity))
      throw new Error(`${entity} has no list read and no list override source`);
    return entityListBaseFor(entity).listQueryPlan;
  }, [entity, operations?.list, parts.source]);

  // `deletable` defaults ON: a top-level list page owns its entity's rows,
  // where an embedded relationship ledger does not.
  const initialColumnVisibility = useListInitialColumnVisibility(
    entity,
    listOptions?.initialColumnVisibility,
  );
  const additionalReadFields = useMemo(() => {
    const parentField = entitySummary[entity].list.tree?.parentField;
    const parentReadKey = parentField
      ? entityFieldModels[entity].fields.find(
          (field) => field.key === parentField,
        )?.readKey
      : undefined;
    return [
      ...(parts.wrapReadFields ?? []),
      ...(listOptions?.additionalReadFields ?? []),
      ...(renderedView === "shelf"
        ? [
            "displayImages",
            ...(entitySummary[entity].list.shelf?.subtitle ?? []),
          ]
        : []),
      ...(parts.tree
        ? [
            "componentCount",
            "categoryId",
            "candidates",
            ...(parentReadKey ? [parentReadKey] : []),
          ]
        : []),
    ];
  }, [
    entity,
    parts.tree,
    parts.wrapReadFields,
    listOptions?.additionalReadFields,
    renderedView,
  ]);
  const list = useEntityList<BaseListRow, object, BaseListRow>({
    entity,
    queryOptions,
    columns,
    deletable: true,
    preview: DEFAULT_PREVIEW,
    ...listOptions,
    initialColumnVisibility,
    additionalReadFields,
    filterOptions,
    // SAFETY: the flat and tree overloads only differ in whether `tree` is
    // present; the hook branches on it at runtime.
    tree: parts.tree as EntityListTreeConfig<BaseListRow, BaseListRow>,
  });
  usePageCount(list.totalCount);
  // The module's hook or a no-op: one call per render either way.
  const useWorkbenchProps = parts.useWorkbench ?? useNoWorkbenchProps;
  const workbenchProps = useWorkbenchProps(list);
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    inspectRow,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = list.inspection;
  // Bulk actions only exist in List. Do not leave a hidden selection behind
  // when Cards or Compact becomes the active presentation.
  useEffect(() => {
    if (
      renderedView !== "table" &&
      Object.keys(list.workbench.table.atoms.rowSelection?.get() ?? {}).length >
        0
    )
      list.workbench.table.resetRowSelection();
  }, [list.workbench.table, renderedView]);
  const scopeChips = (
    <ListScopeChips
      entity={entity}
      search={context.search}
      onClear={(urlKey) =>
        context.navigate({ [urlKey]: undefined }, { replace: true })
      }
    />
  );
  const sweepEntity = z.enum(shortcodeEntities).safeParse(entity);
  const sweepAction = sweepEntity.success ? (
    <SuggestionSweepAction
      entity={sweepEntity.data}
      filters={list.currentFilters}
    />
  ) : null;
  const contextualStatus =
    workbenchProps.contextualStatus === undefined ? (
      scopeChips
    ) : (
      <>
        {scopeChips}
        {workbenchProps.contextualStatus}
      </>
    );

  const body = (
    <>
      {parts.above?.(list)}
      <ListTotalSummary
        totals={entitySummary[entity].list.totals}
        sums={list.sums}
        state={list.summaryState}
        onRetry={list.retrySummary}
      />
      {sweepAction}
      {list.enrichmentFailures?.map(({ pageIndex, group, state }) => (
        <div key={`${pageIndex}:${group}`} className="min-w-0 text-sm">
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
          {getAppErrorDetails(state.cause).code && (
            <p className="font-mono text-xs">
              {getAppErrorDetails(state.cause).code}
            </p>
          )}
          <ErrorDetails error={state.cause} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void list.retryEnrichment?.(pageIndex, group)}
          >
            Retry {group}
          </Button>
        </div>
      ))}
      <Stack gap="sm">
        {renderedView !== "table" && (
          <DataTableToolbar
            table={list.workbench.table}
            entity={entity}
            portalWorkbenchUtilities
          />
        )}
        {renderedView === "table" && (
          <ListWorkbench
            model={list.workbench}
            ariaLabel={`${entities[entity].pluralLabel} table`}
            onRowClick={onRowClick}
            onRowHover={onRowHover}
            onRowHoverEnd={onRowHoverEnd}
            currentRowId={preview?.rowKey ?? preview?.id}
            desktopInspector={dockedInspector}
            inspectorToggle={inspectorToggle}
            {...workbenchProps}
            contextualStatus={contextualStatus}
          />
        )}
        {renderedView === "shelf" && (
          <>
            {inspectorToggle}
            <div
              className={
                dockedInspector
                  ? "grid min-w-0 grid-cols-[minmax(0,1fr)_25rem]"
                  : "min-w-0"
              }
            >
              <div className="min-w-0">
                <EntityShelf
                  entity={entity}
                  // `data` is the canonical flat server projection before
                  // tree nesting and synthetic grouping rows reach the table.
                  // A shelf must never turn either into cards.
                  items={list.data}
                  enrichmentState={list.enrichmentState}
                  isLoading={list.workbench.isLoading}
                  error={list.workbench.error}
                  infiniteScroll={list.workbench.infiniteScroll}
                  compact={density === "compact"}
                  groupConfig={
                    list.workbench.grouped
                      ? list.workbench.groupConfig
                      : undefined
                  }
                  onRetry={() =>
                    void list.workbench.refreshControls.onRefresh()
                  }
                  onInspect={(record) =>
                    inspectRow({
                      id: record.id,
                      original:
                        entity === "wish"
                          ? {
                              ...record,
                              entityKind: entity,
                              previewId: record.id,
                            }
                          : record,
                    })
                  }
                  onRowHover={(record) =>
                    onRowHover({
                      id: record.id,
                      original:
                        entity === "wish"
                          ? {
                              ...record,
                              entityKind: entity,
                              previewId: record.id,
                            }
                          : record,
                    })
                  }
                  onRowHoverEnd={(record) =>
                    onRowHoverEnd({ id: record.id, original: record })
                  }
                  currentRowId={preview?.rowKey ?? preview?.id}
                />
              </div>
              {dockedInspector && (
                <aside className="max-h-[calc(100vh-10rem)] overflow-y-auto border-l border-[var(--border)]">
                  {dockedInspector}
                </aside>
              )}
            </div>
          </>
        )}
        {renderedView === "shelf" && !list.workbench.infiniteScroll && (
          <DataTablePagination
            table={list.workbench.table}
            timing={list.workbench.timing}
          />
        )}
        {renderedView === "timeline" && isTimelineEntity(entity) && (
          <ListTimeline
            entity={entity}
            filters={list.currentFilters}
            context={context}
          />
        )}
      </Stack>
      <PreviewSheet />
      {renderedView !== "table" && list.workbench.deleteDialog}
      {parts.below?.(list)}
    </>
  );
  return (
    <>
      {parts.wrap
        ? parts.wrap(body, {
            data: list.data.filter((row) =>
              (parts.wrapReadFields ?? []).every((field) => {
                const state = list.enrichmentState?.(row.id, field);
                return !state || state.state === "ready";
              }),
            ),
          })
        : body}
    </>
  );
}

/** The Timeline view: the entity's timeline over the current filters, window in the search keys. */
function ListTimeline({
  entity,
  filters,
  context,
}: {
  entity: TimelineEntity;
  filters: object;
  context: ListOverrideContext;
}) {
  const { search, navigate } = context;
  const controls = z
    .object({
      timelineFrom: z.string().optional(),
      timelineTo: z.string().optional(),
      timelineOrder: z.enum(["asc", "desc"]).optional(),
      timelineMode: z.enum(["events", "lifecycles"]).optional(),
    })
    .catch({})
    .parse(search);
  return (
    <EntityTimeline
      entity={entity}
      // SAFETY: `currentFilters` is the entity's own list filter object, which
      // is what its timeline read takes.
      filters={filters as never}
      from={controls.timelineFrom}
      to={controls.timelineTo}
      order={controls.timelineOrder ?? "desc"}
      mode={controls.timelineMode ?? "events"}
      controlsPlacement="band"
      onControlsChange={(patch) => {
        const next: ListSearch = {};
        if ("from" in patch) next.timelineFrom = patch.from;
        if ("to" in patch) next.timelineTo = patch.to;
        if ("order" in patch) next.timelineOrder = patch.order;
        if ("mode" in patch) next.timelineMode = patch.mode;
        navigate(next, { replace: true });
      }}
    />
  );
}

/** Client-paged rows (cookbook): same columns, workbench and preview seam. */
function ClientListBody({
  entity,
  view,
  override,
  context,
}: {
  entity: BrowserRoutedEntity;
  view: "table" | "shelf" | "timeline";
  override: AnyEntityListOverride;
  context: ListOverrideContext;
}) {
  const { density } = useEntityListCardDensity();
  const parts = override.use(context);
  const { columns } = useListColumns(entity, parts, false);
  const initialColumnVisibility = useListInitialColumnVisibility(
    entity,
    parts.list?.initialColumnVisibility,
  );
  const client = parts.client;
  if (!client)
    throw new Error(`${entity} list override declares no client rows`);
  const { workbench, inspection } = useClientEntityList<BaseListRow>({
    entity,
    data: client.data,
    isLoading: client.isLoading,
    error: client.error,
    refetch: client.refetch,
    isRefreshing: client.isRefreshing,
    matchesSearch: client.matchesSearch,
    columns,
    preview: DEFAULT_PREVIEW,
    ...parts.list,
    initialColumnVisibility,
  });
  usePageCount(
    client.isLoading
      ? undefined
      : workbench.table.getFilteredRowModel().rows.length,
  );
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    inspectRow,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  useEffect(() => {
    if (
      view !== "table" &&
      Object.keys(workbench.table.atoms.rowSelection?.get() ?? {}).length > 0
    )
      workbench.table.resetRowSelection();
  }, [view, workbench.table]);
  const body = (
    <>
      {view === "table" ? (
        <ListWorkbench
          model={workbench}
          ariaLabel={`${entities[entity].pluralLabel} table`}
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          onRowHoverEnd={onRowHoverEnd}
          currentRowId={preview?.id}
          desktopInspector={dockedInspector}
          inspectorToggle={inspectorToggle}
        />
      ) : (
        <Stack gap="sm">
          <DataTableToolbar table={workbench.table} entity={entity} />
          {inspectorToggle}
          <div
            className={
              dockedInspector
                ? "grid min-w-0 grid-cols-[minmax(0,1fr)_25rem]"
                : "min-w-0"
            }
          >
            <div className="min-w-0">
              <EntityShelf
                entity={entity}
                items={workbench.table
                  .getRowModel()
                  .rows.map((row) => row.original)}
                isLoading={workbench.isLoading}
                error={workbench.error}
                compact={density === "compact"}
                onRetry={
                  workbench.refreshControls
                    ? () => void workbench.refreshControls?.onRefresh()
                    : undefined
                }
                onInspect={(record) =>
                  inspectRow({ id: record.id, original: record })
                }
                onRowHover={(record) =>
                  onRowHover({ id: record.id, original: record })
                }
                onRowHoverEnd={(record) =>
                  onRowHoverEnd({ id: record.id, original: record })
                }
                currentRowId={preview?.rowKey ?? preview?.id}
              />
            </div>
            {dockedInspector && (
              <aside className="max-h-[calc(100vh-10rem)] overflow-y-auto border-l border-[var(--border)]">
                {dockedInspector}
              </aside>
            )}
          </div>
          <DataTablePagination table={workbench.table} />
        </Stack>
      )}
      <PreviewSheet />
    </>
  );
  return <>{parts.wrap ? parts.wrap(body, { data: client.data }) : body}</>;
}
