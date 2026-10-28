import type { ConnectedRecordsOutput } from "@cubby/schemas/connected-records";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { type BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useQuery, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { flexRender, type RowData } from "@tanstack/react-table";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { createEntityDisplayColumns } from "~/entity/display/entity-display";
import { EntityEditDialog } from "~/entity/editing/entity-edit-dialog";
import type {
  EditableEntity,
  EntityMutationPort,
} from "~/entity/editing/types";
import { entityListFor } from "~/entity/entity-list";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { getEntityFilters } from "~/entity/filter-manifest";
import { buildFiltersFromManifest } from "~/entity/filters";
import {
  listEntities,
  entityListParamsFromParsed,
  parseEntityListInput,
  type ListEntity,
} from "~/entity/generated/entity-lists.gen";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import {
  connectionRefs,
  ConnectionPaths,
} from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { entityList } from "~/integrations/tanstack-query/generated/catalog/entityList.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { Button } from "~/ui/primitives/button";

import {
  useSectionCount,
  useSectionEmpty,
} from "../../ui/data-table/detail-section-state";
import {
  createCubbyColumnHelper,
  createCubbyColumnCollection,
  type CubbyTable,
} from "../../ui/data-table/table-features";
import type { ListQueryOptionsFn } from "../../ui/hooks/use-paginated-table-core";
import { type BaseListRow, useEntityList } from "../hooks/use-entity-list";
import { useEntityFieldSave } from "../hooks/use-update-mutation";
import { ListQueryProvider } from "../table/list-query-context";
import { ListWorkbench } from "../table/list-workbench";
import { RelationScopeContext } from "./relation-scope";
import {
  relationshipMovementSource,
  RelationshipMovementBadges,
  RelationshipMovementProvider,
  type RelationshipMovementOperations,
} from "./relationship-movement";

type RelationSection = Extract<
  CompiledEntityPresentation["detail"]["sections"][number],
  { kind: "relation" }
>;

/** A compiled relation section, bound to its source entity for runtime actions. */
export type RelationSectionPlan = Omit<
  import("@cubby/schemas/entity-definitions/relation-plan").CompiledRelationSectionPlan,
  "target"
> & { source: BrowserRoutedEntity; relation: string; target: ListEntity };

const isListEntity = (value: string): value is ListEntity =>
  listEntities.some((entity) => entity === value);

export function planRelationSection(
  queryClient: QueryClient,
  entity: BrowserRoutedEntity,
  section: RelationSection,
): RelationSectionPlan {
  const relation = entityMetadata(
    queryClient,
    entity,
  ).descriptor.relationships.find(
    (candidate) => candidate.key === section.relation,
  );
  const plan = section.plan;
  if (!plan)
    throw new Error(`${entity}.${section.id} has no compiled relation plan`);
  if (relation?.target !== plan.target)
    throw new Error(
      `${entity}.${section.id} has an inconsistent relation target`,
    );
  if (!isListEntity(plan.target))
    throw new Error(`${entity}.${section.id} targets an unavailable list`);
  return {
    ...plan,
    target: plan.target,
    source: entity,
    relation: section.relation,
  };
}

export interface EntityRelationTableOperations extends RelationshipMovementOperations {
  list: typeof entityList.list;
  /** Test seam: a local operation adapter for the rows' inline field edits. */
  mutationPort?: EntityMutationPort;
}

const productionOperations: EntityRelationTableOperations = {
  list: entityList.list,
};

/**
 * Shared create-dialog state for a relation section's "+ Add"/"New <thing>"
 * triggers — the header action and the empty state each mount their own
 * instance (only one is ever visible at a time), so neither has to reach
 * into the other's state.
 */
function useRelationCreateDialog(plan: RelationSectionPlan, recordId: string) {
  const [creating, setCreating] = useState(false);
  const dialog =
    plan.seed !== null ? (
      <EntityEditDialog
        open={creating}
        onOpenChange={setCreating}
        // SAFETY: `seed.intent` is the compiler-selected create intent and
        // `seed.field` one of that intent's declared fields; the generic
        // dialog resolves both at runtime through the registry.
        request={
          {
            entity: plan.target as EditableEntity,
            operation: "create",
            intent: plan.seed.intent,
            seed: {
              [plan.seed.field]: plan.seedMultiple ? [recordId] : recordId,
            },
          } as never
        }
      />
    ) : null;
  return { creating, setCreating, dialog };
}

/**
 * A relation section's header-row actions: "+ Add" (or a declared
 * `createLabel`, e.g. the journal's "Log entry") plus "Open all", rendered as
 * the `SectionCard`'s `headerAction` — physically in the header row, not the
 * body, so both persist even while the section is collapsed... except they
 * don't: `SectionCard` hides `headerAction` while collapsed-and-closed.
 */
export function RelationSectionActions({
  plan,
  recordId,
  title,
  createLabel,
}: {
  plan: RelationSectionPlan;
  recordId: string;
  title: string;
  createLabel?: string;
}) {
  const {
    summary: { singular },
  } = useEntityMetadata(plan.target);
  const { setCreating, dialog } = useRelationCreateDialog(plan, recordId);

  return (
    <div className="flex items-center gap-1">
      {plan.seed !== null ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={createLabel ?? `New ${singular.toLocaleLowerCase()}`}
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
          {createLabel ?? "Add"}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        nativeButton={false}
        render={
          <Link
            to="/connections"
            search={{
              source: plan.source,
              id: recordId,
              view: `relation:${plan.relation}`,
            }}
            aria-label={`Open all ${title.toLocaleLowerCase()}`}
          />
        }
      >
        Open all
        <ArrowUpRightIcon />
      </Button>
      {dialog}
    </div>
  );
}

/** The section header owns creation; an empty body keeps one compact state message. */
function RelationEmptyState({ emptyLabel }: { emptyLabel: string }) {
  return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
}

/** Skeleton cells sized like the data they'll hold, no shimmer. */
function SkeletonBody({
  rows,
  columnKeys,
}: {
  rows: number;
  columnKeys: readonly (string | number)[];
}) {
  return (
    <tbody>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} className="h-7 border-b border-border/60">
          {columnKeys.map((key, cellIndex) => (
            <td key={key} className="px-2">
              {cellIndex === 0 && rowIndex === 0 ? (
                <span className="sr-only">Loading</span>
              ) : null}
              <div
                aria-hidden
                className="h-3 rounded-sm bg-muted"
                style={{
                  width: `${40 + ((cellIndex * 17 + rowIndex * 11) % 40)}%`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/**
 * The declaration renders its header and columns immediately; only cells are
 * skeletons, sized like the data they'll hold, no shimmer — `RTable`'s own
 * `isLoading` state replaces the whole table with a spinner, which loses the
 * header, so this reuses the real (data-independent) header row instead.
 */
function RelationLoadingSkeleton<TItem extends RowData>({
  table,
  rows,
}: {
  table: CubbyTable<TItem>;
  rows: number;
}) {
  const headerGroups = table.getHeaderGroups();
  const leafHeaders = headerGroups[headerGroups.length - 1]?.headers ?? [];
  return (
    <table
      className="w-full border-collapse text-xs"
      aria-busy
      aria-label="Loading"
    >
      <thead>
        {headerGroups.map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                className="h-8 border-b border-border px-2 text-left text-xs font-medium text-muted-foreground"
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <SkeletonBody
        rows={rows}
        columnKeys={leafHeaders.map((header) => header.id)}
      />
    </table>
  );
}

type RelationRow = BaseListRow;
/** One descriptor key → the record's shortcode; the target's schema parses it. */
type RelationFilters = Partial<Record<string, string | boolean>>;

const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

const EvidenceContext = createContext<Map<
  string,
  ConnectedRecordsOutput["items"][number]
> | null>(null);

function ConnectionEvidenceCell({ id }: { id: string }) {
  const evidence = useContext(EvidenceContext)?.get(id);
  return evidence ? (
    <div className="max-w-full min-w-0 overflow-hidden">
      <ConnectionPaths paths={evidence.paths} compact />
    </div>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

type EntityRelationTableProps = {
  plan: RelationSectionPlan;
  recordId: string;
  title: string;
  /** The journal variant's single-line empty copy, in place of the generic
   * "No <plural> yet" sentence. */
  emptyLabel?: string;
  /** Injectable transport seam for tests; production keeps the real one. */
  operations?: EntityRelationTableOperations;
};

/** Rows a loading relation shows: its limit when small, else three. */
const skeletonRowsFor = (plan: RelationSectionPlan) =>
  plan.limit != null ? Math.min(plan.limit, 3) : 3;

/**
 * The streamed relation's pending state avoids constructing a table until its
 * first complete page is available.
 */
function RelationStaticSkeleton({ rows }: { rows: number }) {
  const columns = 4;
  return (
    <table
      className="w-full border-collapse text-xs"
      aria-busy
      aria-label="Loading"
    >
      <thead>
        <tr>
          {Array.from({ length: columns }, (_, index) => (
            <th key={index} className="h-8 border-b border-border px-2">
              <span className="sr-only">Loading column</span>
              <div aria-hidden className="h-2.5 w-16 rounded-sm bg-muted" />
            </th>
          ))}
        </tr>
      </thead>
      <SkeletonBody
        rows={rows}
        columnKeys={Array.from({ length: columns }, (_, index) => index)}
      />
    </table>
  );
}

/**
 * A relation section's body: the target entity's own list, scoped to this
 * record through the declared descriptor, over the shared list workbench so
 * the rows carry the target's registered row actions. No checkbox column or
 * toolbar (`selectable: false`, `toolbarMode="none"`) — a scoped ledger row
 * still gets its own `…` menu.
 */
export function EntityRelationTable(props: EntityRelationTableProps) {
  // Above the live table: its row-action hooks read the scope while it renders.
  const scope = useMemo(
    () => ({ source: props.plan.source, recordId: props.recordId }),
    [props.plan.source, props.recordId],
  );
  return (
    <RelationScopeContext.Provider value={scope}>
      <QuerySection
        title={props.title}
        resetKey={`${props.recordId}:${props.plan.relation}`}
        fallback={<RelationStaticSkeleton rows={skeletonRowsFor(props.plan)} />}
      >
        <StreamedEntityRelationTable {...props} />
      </QuerySection>
    </RelationScopeContext.Provider>
  );
}

function StreamedEntityRelationTable(props: EntityRelationTableProps) {
  const { plan, recordId, operations = productionOperations } = props;
  const queryClient = useQueryClient();
  useEntityMetadata(plan.target);
  // The first page uses exactly the embedded table's opening filters and key.
  // Its ordinary observer then owns edits, grouping and retained refresh state.
  useSuspenseInfiniteQuery(
    entityListFor(plan.target, operations.list).infiniteQueryOptions(
      entityListParamsFromParsed(
        plan.target,
        parseEntityListInput(plan.target, {
          entity: plan.target,
          includeCount: true,
          filters: {
            ...buildFiltersFromManifest(
              getEntityFilters(queryClient, plan.target),
              () => undefined,
            ),
            [plan.filterKey]: recordId,
            ...(plan.subtree === null ? {} : { [plan.subtree]: false }),
          },
          pagination: {
            pageIndex: 0,
            pageSize: plan.pageSize,
          },
          sort: [{ orderBy: plan.sort.field, direction: plan.sort.direction }],
          ...(plan.groupBy ? { groupBy: [{ key: plan.groupBy }] } : {}),
        }),
      ),
    ),
  );
  return <LiveEntityRelationTable {...props} />;
}

function LiveEntityRelationTable({
  plan,
  recordId,
  title,
  emptyLabel,
  operations = productionOperations,
}: EntityRelationTableProps) {
  const { target } = plan;
  const queryClient = useQueryClient();
  useEntityMetadata(target);
  const movementSource = relationshipMovementSource(
    plan.source,
    plan.target,
    plan.relation,
  );
  const listQueryOptions: ListQueryOptionsFn<RelationFilters, RelationRow> =
    useCallback(
      (params) =>
        // SAFETY: the filter object carries the descriptor key the entity
        // compiler checked against this target; the wire input is parsed by
        // the target's own list schema before it executes.
        entityListFor(target, operations.list).listQueryPlan(params as never),
      [operations.list, target],
    );
  const helper = useMemo(() => createCubbyColumnHelper<RelationRow>(), []);
  const scope = useMemo<RelationFilters>(
    () => ({
      [plan.filterKey]: recordId,
      ...(plan.subtree === null ? {} : { [plan.subtree]: false }),
    }),
    [plan.filterKey, plan.subtree, recordId],
  );
  // The same inline scalar editing the target's own list page offers: a row
  // here is the target entity's record, so its update command applies as-is.
  const onSaveField = useEntityFieldSave(target, {
    mutationPort: operations.mutationPort,
  });
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<RelationRow>((add) => {
        createEntityDisplayColumns<RelationRow>(
          queryClient,
          target,
          helper,
          undefined,
          {
            only: plan.columns ?? undefined,
            skipSpecialized: true,
            onSaveField,
            onSaveFields: onSaveField?.row,
          },
        )
          .filter(
            (column) =>
              plan.columns !== null || column.id !== plan.backReferenceColumn,
          )
          .visit(add);
        if (movementSource !== null)
          add(
            helper.display({
              id: "movementEvidence",
              header: "Movement",
              size: 300,
              minSize: 240,
              maxSize: 420,
              cell: ({ row }) => (
                <RelationshipMovementBadges id={row.original.id} compact />
              ),
            }),
          );
        if (!plan.derived)
          add(
            helper.display({
              id: "connection",
              header: "Connected through",
              size: 280,
              minSize: 220,
              maxSize: 380,
              cell: ({ row }) => (
                <ConnectionEvidenceCell id={row.original.id} />
              ),
            }),
          );
      }),
    [
      helper,
      onSaveField,
      plan.backReferenceColumn,
      plan.columns,
      plan.derived,
      target,
      movementSource,
      queryClient,
    ],
  );
  const tableStateOptions = useMemo(
    () => ({
      ...EMBEDDED_TABLE_STATE,
      initialSort: plan.sort.field,
      initialSortDesc: plan.sort.direction === "desc",
      initialPagination: {
        pageIndex: 0,
        pageSize: plan.pageSize,
      },
    }),
    [plan.pageSize, plan.sort.direction, plan.sort.field],
  );
  // Header menus regroup an embedded table for the visit; the declared
  // section grouping is the default on every mount.
  const [groupBy, setGroupBy] = useState(plan.groupBy);
  const list = useEntityList<RelationRow, RelationFilters>({
    entity: target,
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions,
    hiddenFilterColumns: [plan.descriptorId],
    groupBy: groupBy ? [{ key: groupBy }] : undefined,
    onGroupByChange: setGroupBy,
    // H2: never `includeCatalogActions: false` here — that would empty the
    // row `…` menu too. This only drops the checkbox column and bulk bar.
    selectable: false,
  });
  const visibleIds = list.workbench.table
    .getRowModel()
    .rows.map((row) => row.original.id)
    .slice(0, 50);
  const evidenceQuery = useQuery({
    ...entityGraph.connectedRecords.queryOptions({
      source: { entityKind: plan.source, entityId: recordId },
      viewKey: `relation:${plan.relation}`,
      targetIds: visibleIds,
      limit: 50,
    }),
    enabled: !plan.derived,
  });
  const evidence = new Map(
    evidenceQuery.data?.items.map((item) => [item.target.entityId, item]),
  );
  // "Connected through" earns its column only when some row connects through
  // an intermediate record; a direct reference would read "Direct" on every row.
  const hasIndirectPath = evidenceQuery.data?.items.some((item) =>
    item.paths.some((path) => path.length > 2),
  );
  const connectionColumn = list.workbench.table.getColumn("connection");
  useEffect(() => {
    connectionColumn?.toggleVisibility(hasIndirectPath === true);
  }, [connectionColumn, hasIndirectPath]);
  // Header filters narrow this table for the visit; the section stays the
  // record's relation, so its count, emptiness and table do not follow them.
  const filtered = list.workbench.table.state.columnFilters.length > 0;
  const [unfilteredCount, setUnfilteredCount] = useState(list.totalCount);
  if (!filtered && unfilteredCount !== list.totalCount)
    setUnfilteredCount(list.totalCount);
  useSectionCount(unfilteredCount);
  // `list.totalCount` stays `undefined` until the first response lands (see
  // `useEntityList`), so this only fires once the read genuinely resolves
  // empty — never mid-fetch, and never on an error (which leaves it
  // `undefined` too since the query never completes with data).
  const resolvedEmpty =
    !list.workbench.error && !filtered && list.totalCount === 0;
  useSectionEmpty(resolvedEmpty);

  if (list.workbench.error && list.data.length === 0) {
    return (
      <ErrorDisplay
        title={title.toLocaleLowerCase()}
        error={list.workbench.error}
        onRetry={() => void list.workbench.refreshControls.onRefresh()}
      />
    );
  }

  if (list.workbench.isLoading) {
    return (
      <RelationLoadingSkeleton
        table={list.workbench.table}
        rows={skeletonRowsFor(plan)}
      />
    );
  }

  // An empty section is one quiet row: its muted heading and "0". Only a
  // declared sentence (a journal's first-entry prompt, "not a kit yet")
  // earns a body line.
  if (list.totalCount === 0 && !filtered) {
    return emptyLabel === undefined ? null : (
      <RelationEmptyState emptyLabel={emptyLabel} />
    );
  }

  const truncated =
    plan.limit != null &&
    list.totalCount !== undefined &&
    list.totalCount > plan.limit;

  return (
    <RelationshipMovementProvider
      source={movementSource}
      recordId={recordId}
      targetIds={list.workbench.table
        .getRowModel()
        .rows.map((row) => row.original.id)}
      operations={operations}
    >
      <div className="space-y-2">
        <EntityDisplayImagesProvider
          refs={connectionRefs(evidenceQuery.data?.items ?? [])}
        >
          <EvidenceContext.Provider value={evidence}>
            {/* Facets and the live count for header filters come from this
                relation's own query, never an enclosing page list. */}
            <ListQueryProvider
              value={{
                entity: target,
                filters: list.currentFilters,
                matching: list.totalCount,
                chipsTarget: null,
              }}
            >
              <ListWorkbench
                model={list.workbench}
                mode="embedded"
                toolbarMode="none"
                ariaLabel={title}
                renderMobileRowFooter={(row) => {
                  const item = evidence.get(row.id);
                  return item || movementSource !== null ? (
                    <div className="border-t border-border/60 pt-2">
                      {movementSource !== null ? (
                        <RelationshipMovementBadges id={row.id} />
                      ) : null}
                      {item ? (
                        <ConnectionPaths paths={item.paths} compact />
                      ) : null}
                    </div>
                  ) : null;
                }}
              />
            </ListQueryProvider>
          </EvidenceContext.Provider>
        </EntityDisplayImagesProvider>
        {evidenceQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load connection paths: {String(evidenceQuery.error)}
          </p>
        ) : null}
        {truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing {plan.limit} of {list.totalCount} ·{" "}
            <Link
              to="/connections"
              search={{
                source: plan.source,
                id: recordId,
                view: `relation:${plan.relation}`,
              }}
            >
              Open all
            </Link>
          </p>
        ) : null}
      </div>
    </RelationshipMovementProvider>
  );
}
