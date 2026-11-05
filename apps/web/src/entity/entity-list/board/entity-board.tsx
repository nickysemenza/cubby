import type { EntityBoardListView } from "@cubby/schemas/entity-definitions/definition";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupBy } from "@cubby/schemas/pagination";
import {
  DndContext,
  rectIntersection,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { renderCompactFieldValue } from "~/entity/display/entity-display";
import { useReportCommands } from "~/entity/entity-detail/report-commands";
import { entityListFor } from "~/entity/entity-list";
import {
  getEntityFilters,
  manifestFilterFields,
} from "~/entity/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
} from "~/entity/filters";
import { useDeferredReferenceFilterOptions } from "~/entity/hooks/use-deferred-reference-filter-options";
import { useEntityFieldSave } from "~/entity/hooks/use-update-mutation";
import { useEntityMetadata } from "~/entity/metadata";
import {
  type ListEntity,
  parseEntityListInput,
  entityListParamsFromParsed,
} from "~/entity/model/list-contracts";
import { usePageWorkbenchTarget } from "~/entity/page/page";
import { useTableState } from "~/entity/table/use-table-state";
import { Picker } from "~/ui/combobox/picker";
import { DenseCellContext } from "~/ui/common/stacked-value";
import { FilterBar } from "~/ui/data-table/filter-bar";
import {
  filterStateToBarFilters,
  type FilterBarField,
} from "~/ui/data-table/filter-bar-core";
import { useFilterBarDraft } from "~/ui/data-table/use-filter-bar-draft";
import { useCubbyDndSensors } from "~/ui/dnd/sensors";
import { showErrorToast } from "~/ui/feedback/error-details";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { ListLoadingSkeleton } from "~/ui/feedback/loading-skeletons";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Panel } from "~/ui/layout/panel";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import { listGroupBy } from "../list-grouping";
import type { ListSlotProps } from "../list-slot-types";
import {
  boardGroups,
  boardGroupPage,
  boardMoveRequest,
  boardDropBefore,
  type BoardFilters,
  type BoardRow,
  type BoardGroup,
} from "./board-plan";

type BoardEntity = ListEntity & BrowserRoutedEntity;
type Destination = { key: string; before?: string; rows: BoardRow[] };

function boardQuery(
  entity: ListEntity,
  input: {
    filters: BoardFilters;
    pagination: { pageIndex: number; pageSize: number };
    groupBy?: ListGroupBy[];
    sort?: { orderBy: string; direction: "asc" | "desc" }[];
  },
) {
  const parsed = parseEntityListInput(entity, {
    ...input,
    entity,
    includeCount: Boolean(input.groupBy?.length),
  });
  return entityListFor(entity).queryOptions(
    entityListParamsFromParsed(entity, parsed),
  );
}

export function EntityBoard({
  entity,
  view,
  search,
  navigate,
}: ListSlotProps & { entity: BoardEntity; view: EntityBoardListView }) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const choices = useMemo(
    () =>
      metadata.listFields.grouping.filter(
        (choice) =>
          view.groupings.includes(choice.key) &&
          choice.reason === null &&
          choice.filter,
      ),
    [metadata, view],
  );
  const choice =
    choices.find((choice) => choice.key === listGroupBy(search)?.[0]?.key) ??
    choices.find((choice) => choice.key === view.groupBy);
  if (!choice?.filter)
    throw new Error(
      `Board ${entity}.${view.id} has no usable declared grouping`,
    );
  const specs = getEntityFilters(queryClient, entity);
  const primarySearch = metadata.summary.primarySearch;
  const initialFilter = useMemo(
    () => metadata.summary.list.initialFilter.map((filter) => ({ ...filter })),
    [metadata],
  );
  const table = useTableState({
    filterSpecs: specs,
    primarySearch,
    initialFilter,
    urlSync: true,
    syncPaginationToUrl: false,
  });
  const referenceOptions = useDeferredReferenceFilterOptions(entity);
  const fields = useMemo<FilterBarField[]>(() => {
    const declared = manifestFilterFields(specs, referenceOptions);
    return primarySearch
      ? [
          {
            key: primarySearch.key,
            label: "Search",
            type: "text",
            placeholder: primarySearch.placeholder,
          },
          ...declared.filter((field) => field.key !== primarySearch.key),
        ]
      : declared;
  }, [specs, referenceOptions, primarySearch]);
  const externalFilters = useMemo(
    () => filterStateToBarFilters(table.columnFilters, fields),
    [table.columnFilters, fields],
  );
  const { draftFilters, handleChange } = useFilterBarDraft({
    externalFilters,
    fields,
    commit: table.setColumnFilters,
  });
  const filters = {
    ...buildFiltersFromManifest(
      specs,
      filterGetterFromColumnFilters(table.columnFilters),
    ),
    ...(primarySearch
      ? { [primarySearch.key]: table.getColumnFilter(primarySearch.key) }
      : {}),
    ...view.filters,
  };
  const queryInput = {
    filters,
    pagination: { pageIndex: 0, pageSize: 1 },
    groupBy: [{ key: choice.key }],
  };
  const query = useQuery(boardQuery(entity, queryInput));
  const loading = useHydratedLoading(query.isLoading);
  const commands = useReportCommands();
  const sensors = useCubbyDndSensors({
    pointerDistance: 4,
    touchDelay: 250,
    touchTolerance: 8,
    keyboardCoordinates: null,
  });
  const summaries = query.data?.meta.groups ?? [];
  const roster =
    choice.value && "options" in choice.value ? choice.value.options : null;
  const groups = boardGroups(summaries, roster, {
    noValue: choice.filter.noValue,
    noValueLabel: choice.noValueLabel,
  });
  const [groupPage, setGroupPage] = useState(0);
  const options = useMemo(
    () => choices.map((choice) => ({ value: choice.key, label: choice.label })),
    [choices],
  );
  const spec = specs.find((spec) => spec.columnId === choice.filter?.columnId);
  const field = spec?.field ?? choice.filter.columnId;
  // A view without a reorder operation moves a card by writing the grouped field
  // through the entity's ordinary update: no manual order, no second write path.
  const saveField = useEntityFieldSave(entity);
  const [saving, setSaving] = useState(false);
  const pending = commands.pending || saving;
  const canMove = Boolean(view.reorder || saveField);
  const move = (id: string, destination: Destination) => {
    if (pending) return;
    if (!view.reorder) {
      if (!saveField) return;
      setSaving(true);
      void saveField(
        { id },
        field,
        destination.key === FILTER_NONE ? null : destination.key,
      )
        .catch(showErrorToast)
        .finally(() => setSaving(false));
      return;
    }
    commands.run({
      kind: "operation",
      operation: view.reorder.operation,
      body: boardMoveRequest(
        destination.rows,
        id,
        destination.before,
        choice.key,
        destination.key,
      ),
    });
  };
  const moveToGroup = async (id: string, key: string) => {
    const targetGroup = groups.find((group) => group.key === key);
    if (!targetGroup) return;
    if (!view.reorder) {
      move(id, { key, rows: [] });
      return;
    }
    try {
      const scoped = buildFiltersFromManifest(specs, (column) =>
        column === choice.filter?.columnId ? [key] : undefined,
      );
      const input = boardGroupPage(
        view,
        queryInput.filters,
        choice.key,
        field,
        targetGroup,
        0,
      );
      const scopedFilters = { ...input.filters };
      delete scopedFilters[field];
      const target = await queryClient.fetchQuery(
        boardQuery(entity, {
          ...input,
          filters: { ...scopedFilters, ...scoped },
        }),
      );
      move(id, { key, rows: target.items, before: target.items[0]?.id });
    } catch (error) {
      showErrorToast(error);
    }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const target = over?.data.current;
    if (typeof active.id !== "string" || target?.board !== view.id) return;
    const destination: Destination = target.destination;
    if (destination.before === active.id) return;
    if (!view.reorder) {
      // Only a change of group writes; this board has no order within one.
      if (active.data.current?.groupKey !== destination.key)
        move(active.id, destination);
      return;
    }
    const rect = active.rect.current.translated;
    if (destination.before && rect && over) {
      const side =
        rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2
          ? "bottom"
          : "top";
      move(active.id, {
        ...destination,
        before: boardDropBefore(destination.rows, destination.before, side),
      });
    } else move(active.id, destination);
  };
  const utilitiesTarget = usePageWorkbenchTarget();
  const tools = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <FilterBar
        filters={draftFilters}
        fields={fields}
        onChange={handleChange}
        searchKey={primarySearch?.key}
        searchPlaceholder={primarySearch?.placeholder}
        className="min-w-0 flex-1"
      />
      {options.length > 1 && (
        <Picker
          label="Board grouping"
          options={options}
          value={choice.key}
          onValueChange={(groupBy) => {
            setGroupPage(0);
            navigate({ groupBy: groupBy ? [{ key: groupBy }] : undefined });
          }}
        />
      )}
    </div>
  );
  return (
    <div className="min-w-0 space-y-2">
      {/* The same band every list keeps its query tools in. */}
      {utilitiesTarget ? createPortal(tools, utilitiesTarget) : tools}
      {query.error && (
        <ErrorDisplay
          error={query.error}
          title={metadata.summary.plural}
          onRetry={() => void query.refetch()}
        />
      )}
      {loading ? (
        <ListLoadingSkeleton label="Loading board…" />
      ) : query.data && groups.length === 0 ? (
        <p>
          No records to show.{" "}
          <Button
            variant="ghost"
            onClick={() =>
              navigate(
                Object.fromEntries(
                  Object.keys(search)
                    .filter((key) => key !== "view")
                    .map((key) => [key, undefined]),
                ),
              )
            }
          >
            Clear filters
          </Button>
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={onDragEnd}
          collisionDetection={rectIntersection}
        >
          <div className="flex max-w-full items-start gap-2 overflow-x-auto pb-2">
            {groups.slice(groupPage * 12, (groupPage + 1) * 12).map((group) => (
              <BoardGroup
                key={`${JSON.stringify(queryInput.filters)}:${choice.key}:${group.key}`}
                entity={entity}
                view={view}
                group={group}
                filters={queryInput.filters}
                groupBy={choice.key}
                filterField={field}
                filterColumn={choice.filter.columnId}
                groups={groups}
                move={move}
                moveToGroup={moveToGroup}
                pending={pending}
                canMove={canMove}
                acceptsNoValue={choice.filter.noValue}
              />
            ))}
          </div>
        </DndContext>
      )}
      {groups.length > 12 && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={groupPage === 0}
            onClick={() => setGroupPage(groupPage - 1)}
          >
            Previous groups
          </Button>
          <Button
            variant="ghost"
            disabled={(groupPage + 1) * 12 >= groups.length}
            onClick={() => setGroupPage(groupPage + 1)}
          >
            Next groups
          </Button>
        </div>
      )}
    </div>
  );
}

function BoardGroup({
  entity,
  view,
  group,
  filters,
  groupBy,
  filterField,
  filterColumn,
  groups,
  move,
  moveToGroup,
  pending,
  canMove,
  acceptsNoValue,
}: {
  entity: BoardEntity;
  view: EntityBoardListView;
  group: BoardGroup;
  filters: BoardFilters;
  groupBy: string;
  filterField: string;
  filterColumn: string;
  groups: BoardGroup[];
  move: (id: string, destination: Destination) => void;
  moveToGroup: (id: string, key: string) => Promise<void>;
  pending: boolean;
  canMove: boolean;
  acceptsNoValue: boolean;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const [page, setPage] = useState(0);
  const input = boardGroupPage(
    view,
    filters,
    groupBy,
    filterField,
    group,
    page,
  );
  const groupFilters = buildFiltersFromManifest(
    getEntityFilters(queryClient, entity),
    (column) => (column === filterColumn ? [group.key] : undefined),
  );
  const scopedFilters = { ...input.filters };
  delete scopedFilters[filterField];
  const query = useQuery({
    ...boardQuery(entity, {
      ...input,
      filters: { ...scopedFilters, ...groupFilters },
    }),
    enabled: group.count > 0,
  });
  const rows: BoardRow[] = query.data?.items ?? [];
  const loading = useHydratedLoading(query.isLoading);
  const destination = { key: group.key, rows };
  const acceptsPlacement = group.key !== FILTER_NONE || acceptsNoValue;
  const drop = useDroppable({
    id: `group:${group.key}`,
    data: { board: view.id, destination },
    disabled: pending || !canMove || !acceptsPlacement,
  });
  const capped = view.caps.some(
    (cap) => cap.field === groupBy && cap.value === group.key,
  );
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={group.label}
      className="w-60 shrink-0 rounded-[var(--brand-web-radius-panel)] bg-muted/50 p-1"
    >
      <h2 className="flex h-(--table-row-height) items-center justify-between gap-2 px-1 text-xs font-medium">
        <span className="truncate">{group.label}</span>
        <span className="font-normal text-muted-foreground tabular-nums">
          {group.count}
        </span>
      </h2>
      {query.error && (
        <ErrorDisplay
          error={query.error}
          title={group.label}
          onRetry={() => void query.refetch()}
        />
      )}
      {loading ? (
        <ListLoadingSkeleton label={`Loading ${group.label}…`} count={3} />
      ) : (
        rows.map((row, index) => (
          <BoardCard
            key={row.id}
            entity={entity}
            view={view}
            row={row}
            destination={{ ...destination, before: row.id }}
            groupKey={group.key}
            groupField={filterField}
            disabled={pending}
            canMove={canMove}
            manualOrder={Boolean(view.reorder) && !capped && acceptsPlacement}
            menu={
              canMove ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={pending}
                        aria-label={`Move ${String(row[metadata.summary.titleField] ?? row.id)}`}
                        className="shrink-0 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100"
                      />
                    }
                  >
                    <DotsThreeIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto min-w-40">
                    {view.reorder && !capped && acceptsPlacement && (
                      <>
                        <DropdownMenuItem
                          disabled={index === 0}
                          onClick={() =>
                            move(row.id, {
                              ...destination,
                              before: rows[index - 1]?.id,
                            })
                          }
                        >
                          Earlier
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={index === rows.length - 1}
                          onClick={() =>
                            move(row.id, {
                              ...destination,
                              before: rows[index + 2]?.id,
                            })
                          }
                        >
                          Later
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Move to</DropdownMenuLabel>
                      {groups
                        .filter(
                          (candidate) =>
                            candidate.key !== group.key &&
                            (candidate.key !== FILTER_NONE || acceptsNoValue),
                        )
                        .map((candidate) => (
                          <DropdownMenuItem
                            key={candidate.key}
                            onClick={() =>
                              void moveToGroup(row.id, candidate.key)
                            }
                          >
                            {candidate.label}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null
            }
          />
        ))
      )}
      {!query.isLoading && rows.length === 0 && !query.error && (
        <p className="px-1 py-0.5 text-xs text-muted-foreground">No records</p>
      )}
      {/* One page needs no pager; a capped group says how much it shows. */}
      {(capped ? group.count > rows.length : group.count > view.pageSize) && (
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
          <span>
            {capped
              ? `${rows.length} of ${group.count} shown`
              : `Page ${page + 1}`}
          </span>
          {!capped && (
            <div>
              <Button
                size="xs"
                variant="ghost"
                disabled={page === 0 || query.isFetching}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={
                  (page + 1) * view.pageSize >= group.count || query.isFetching
                }
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BoardCard({
  entity,
  view,
  row,
  destination,
  groupKey,
  groupField,
  disabled,
  canMove,
  manualOrder,
  menu,
}: {
  entity: BoardEntity;
  view: EntityBoardListView;
  row: BoardRow;
  destination: Destination;
  groupKey: string;
  /** The field the column already states; a card does not repeat it. */
  groupField: string;
  disabled: boolean;
  canMove: boolean;
  manualOrder: boolean;
  menu: ReactNode;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const drag = useDraggable({
    id: row.id,
    data: { groupKey },
    disabled: disabled || !canMove,
  });
  const drop = useDroppable({
    id: `card:${row.id}`,
    data: { board: view.id, destination },
    disabled: disabled || !manualOrder,
  });
  return (
    <Panel
      tone="default"
      flush
      render={
        <article
          ref={(node) => {
            drop.setNodeRef(node);
            drag.setNodeRef(node);
          }}
        />
      }
      style={
        drag.transform
          ? {
              transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`,
            }
          : undefined
      }
      className={cn(
        "group/card mb-1 px-1.5 py-1 text-sm",
        drag.isDragging && "relative z-10 opacity-80",
      )}
    >
      <div className="flex min-h-(--control-height-xs) items-center gap-1">
        {canMove && (
          <button
            type="button"
            ref={drag.setActivatorNodeRef}
            {...drag.listeners}
            {...drag.attributes}
            tabIndex={-1}
            aria-hidden="true"
            aria-label={`Drag ${String(row[metadata.summary.titleField] ?? row.id)}`}
            className="-ml-0.5 flex min-h-11 shrink-0 cursor-grab touch-none items-center text-muted-foreground opacity-40 group-hover/card:opacity-100 active:cursor-grabbing md:min-h-(--control-height-xs)"
          >
            <DotsSixVerticalIcon aria-hidden="true" className="size-3" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate">
          {/* The dense form holds a long name to the card's one line. */}
          <DenseCellContext value={{ linksTo: null }}>
            <EntityRefLink
              entity={entity}
              id={row.id}
              name={String(row[metadata.summary.titleField] ?? row.id)}
            />
          </DenseCellContext>
        </span>
        {menu}
      </div>
      <dl className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-3.5 text-xs">
        {view.cardFields
          .filter((key) => key !== groupField)
          .map((key) => {
            const field = metadata.fields.fields.find(
              (field) => field.key === key,
            );
            return field ? (
              <div key={key} className="flex min-w-0 items-center">
                <dt className="sr-only">{field.label}</dt>
                <dd className="min-w-0 truncate">
                  {renderCompactFieldValue(queryClient, entity, row, field)}
                </dd>
              </div>
            ) : null;
          })}
      </dl>
    </Panel>
  );
}
