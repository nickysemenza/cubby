import type { EntityBoardListView } from "@cubby/schemas/entity-definitions/definition";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ArrowsVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsVertical";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { renderCompactFieldValue } from "~/entity/display/entity-display";
import { entities, entityDetailParams } from "~/entity/entities";
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
import {
  type ListEntity,
  entityListInputSchema,
  entityListParamsFromParsed,
} from "~/entity/generated/entity-lists.gen";
import { useDeferredReferenceFilterOptions } from "~/entity/hooks/use-deferred-reference-filter-options";
import { useTableState } from "~/entity/table/use-table-state";
import { Picker } from "~/ui/combobox/picker";
import { FilterBar } from "~/ui/data-table/filter-bar";
import {
  filterStateToBarFilters,
  type FilterBarField,
} from "~/ui/data-table/filter-bar-core";
import { useFilterBarDraft } from "~/ui/data-table/use-filter-bar-draft";
import {
  useCubbyDndSensors,
  createValidTargetKeyboardCoordinates,
} from "~/ui/dnd/sensors";
import { showErrorToast } from "~/ui/feedback/error-details";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { ListLoadingSkeleton } from "~/ui/feedback/loading-skeletons";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Button } from "~/ui/primitives/button";

import type { ListSlotProps } from "../list-slot-types";
import {
  boardGroupPage,
  boardMoveRequest,
  boardDropBefore,
  type BoardFilters,
  type BoardRow,
} from "./board-plan";

type BoardEntity = ListEntity & BrowserRoutedEntity;
type Destination = { key: string; before?: string; rows: BoardRow[] };

function boardQuery(
  entity: ListEntity,
  input: {
    filters: BoardFilters;
    pagination: { pageIndex: number; pageSize: number };
    groupBy?: string;
    sort?: { orderBy: string; direction: "asc" | "desc" }[];
  },
) {
  const parsed = entityListInputSchema.parse({ ...input, entity });
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
  const choices = useMemo(
    () =>
      generatedEntityListFields[entity].grouping.filter(
        (choice) =>
          view.groupings.includes(choice.key) &&
          choice.reason === null &&
          choice.filter,
      ),
    [entity, view],
  );
  const choice =
    choices.find((choice) => choice.key === search.groupBy) ??
    choices.find((choice) => choice.key === view.groupBy);
  if (!choice?.filter)
    throw new Error(
      `Board ${entity}.${view.id} has no usable declared grouping`,
    );
  const specs = getEntityFilters(entity);
  const primarySearch = entitySummary[entity].primarySearch;
  const initialFilter = useMemo(
    () =>
      entitySummary[entity].list.initialFilter.map((filter) => ({ ...filter })),
    [entity],
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
    groupBy: choice.key,
  };
  const query = useQuery(boardQuery(entity, queryInput));
  const loading = useHydratedLoading(query.isLoading);
  const commands = useReportCommands();
  const queryClient = useQueryClient();
  const keyboardCoordinates = useMemo(
    () =>
      createValidTargetKeyboardCoordinates(
        (active, target) =>
          target?.board === view.id &&
          target?.destination?.before !== active?.rowId &&
          (target?.destination?.before !== undefined ||
            target?.destination?.key !== active?.groupKey),
      ),
    [view.id],
  );
  const sensors = useCubbyDndSensors({
    pointerDistance: 4,
    touchDelay: 250,
    touchTolerance: 8,
    keyboardCoordinates,
  });
  const summaries = query.data?.meta.groups ?? [];
  const roster =
    choice.value && "options" in choice.value ? choice.value.options : null;
  const groups: ListGroupSummary[] = roster
    ? [
        ...roster.map(
          (option) =>
            summaries.find((group) => group.key === option.value) ?? {
              key: option.value,
              label: option.label,
              count: 0,
            },
        ),
        ...summaries.filter(
          (group) => !roster.some((option) => option.value === group.key),
        ),
      ]
    : summaries;
  const [groupPage, setGroupPage] = useState(0);
  const options = useMemo(
    () => choices.map((choice) => ({ value: choice.key, label: choice.label })),
    [choices],
  );
  const spec = getEntityFilters(entity).find(
    (spec) => spec.columnId === choice.filter?.columnId,
  );
  const field = spec?.field ?? choice.filter.columnId;
  const move = (id: string, destination: Destination) => {
    if (!view.reorder || commands.pending) return;
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
    try {
      const scoped = buildFiltersFromManifest(
        getEntityFilters(entity),
        (column) => (column === choice.filter?.columnId ? [key] : undefined),
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
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterBar
          filters={draftFilters}
          fields={fields}
          onChange={handleChange}
          searchKey={primarySearch?.key}
          searchPlaceholder={primarySearch?.placeholder}
          className="min-w-0 flex-1"
        />
        <Picker
          label="Board grouping"
          options={options}
          value={choice.key}
          onValueChange={(groupBy) => {
            setGroupPage(0);
            navigate({ groupBy });
          }}
        />
      </div>
      {query.error && (
        <ErrorDisplay
          error={query.error}
          title={entitySummary[entity].plural}
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
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex max-w-full items-start gap-3 overflow-x-auto pb-2">
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
                pending={commands.pending}
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
}: {
  entity: BoardEntity;
  view: EntityBoardListView;
  group: ListGroupSummary;
  filters: BoardFilters;
  groupBy: string;
  filterField: string;
  filterColumn: string;
  groups: ListGroupSummary[];
  move: (id: string, destination: Destination) => void;
  moveToGroup: (id: string, key: string) => Promise<void>;
  pending: boolean;
}) {
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
    getEntityFilters(entity),
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
  const drop = useDroppable({
    id: `group:${group.key}`,
    data: { board: view.id, destination },
    disabled: pending || !view.reorder,
  });
  const capped = view.caps.some(
    (cap) => cap.field === groupBy && cap.value === group.key,
  );
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={group.label}
      className="w-64 shrink-0 space-y-2"
    >
      <h2 className="flex justify-between px-2 py-1 text-sm font-semibold">
        <span>{group.label}</span>
        <span className="font-normal tabular-nums">{group.count}</span>
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
            disabled={pending}
            manualOrder={!capped}
          >
            {view.reorder && (
              <div className="flex flex-wrap gap-1">
                {!capped && index > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      move(row.id, {
                        ...destination,
                        before: rows[index - 1]?.id,
                      })
                    }
                  >
                    Earlier
                  </Button>
                )}
                {!capped && index < rows.length - 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      move(row.id, {
                        ...destination,
                        before: rows[index + 2]?.id,
                      })
                    }
                  >
                    Later
                  </Button>
                )}
                <Picker
                  label={`Move ${String(row[entitySummary[entity].titleField] ?? row.id)}`}
                  options={groups.map((group) => ({
                    value: group.key,
                    label: group.label,
                  }))}
                  value={group.key}
                  onValueChange={(key) => {
                    if (key && key !== group.key) void moveToGroup(row.id, key);
                  }}
                  disabled={pending}
                />
              </div>
            )}
          </BoardCard>
        ))
      )}
      {!query.isLoading && rows.length === 0 && !query.error && (
        <p className="p-2 text-sm text-muted-foreground">No records</p>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {capped
            ? `${rows.length} of ${group.count} shown`
            : `Page ${page + 1}`}
        </span>
        {!capped && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0 || query.isFetching}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
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
    </section>
  );
}

function BoardCard({
  entity,
  view,
  row,
  destination,
  disabled,
  manualOrder,
  children,
}: {
  entity: BoardEntity;
  view: EntityBoardListView;
  row: BoardRow;
  destination: Destination;
  disabled: boolean;
  manualOrder: boolean;
  children: ReactNode;
}) {
  const drag = useDraggable({
    id: row.id,
    data: { rowId: row.id, groupKey: destination.key },
    disabled: disabled || !view.reorder || !manualOrder,
  });
  const drop = useDroppable({
    id: `card:${row.id}`,
    data: { board: view.id, destination },
    disabled: disabled || !manualOrder,
  });
  return (
    <article
      ref={(node) => {
        drop.setNodeRef(node);
        drag.setNodeRef(node);
      }}
      className="space-y-2 border-b p-2 text-sm"
    >
      <div className="flex items-start gap-2">
        {view.reorder && manualOrder && (
          <button
            type="button"
            ref={drag.setActivatorNodeRef}
            {...drag.listeners}
            {...drag.attributes}
            aria-label={`Drag ${String(row[entitySummary[entity].titleField] ?? row.id)}`}
            className="min-h-11 px-2 text-muted-foreground md:min-h-7"
          >
            <ArrowsVerticalIcon aria-hidden="true" />
          </button>
        )}
        <EntityRefLink
          variant="table"
          to={entities[entity].routes.detail}
          params={entityDetailParams(row.id)}
        >
          {String(row[entitySummary[entity].titleField] ?? row.id)}
        </EntityRefLink>
      </div>
      <dl className="space-y-1">
        {view.cardFields.map((key) => {
          const field = entityFieldModels[entity].fields.find(
            (field) => field.key === key,
          );
          return field ? (
            <div key={key} className="flex flex-wrap justify-between gap-1">
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd>{renderCompactFieldValue(entity, row, field)}</dd>
            </div>
          ) : null;
        })}
      </dl>
      {children}
    </article>
  );
}
