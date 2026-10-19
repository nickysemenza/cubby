import type { Entity } from "@cubby/schemas/entity";
import { BookmarkIcon } from "@phosphor-icons/react/dist/csr/Bookmark";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { Link, useNavigate } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { Fragment } from "react";

import type { ListSearch } from "~/entity/entity-list/list-slot-types";
import {
  type ListEntity,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import {
  isViewActive,
  type ViewDefinition,
  viewsForEntity,
} from "~/entity/model/view-manifest";
import { useViewCounts } from "~/entity/table/list-query-context";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import { applyColumnLayout } from "../../ui/data-table/column-layout";
import type { CubbyTable as Table } from "../../ui/data-table/table-features";

interface DataTableViewsProps<TData extends RowData> {
  table: Table<TData>;
  entity: Entity | undefined;
}

/** A view's exact declared layout — see `ViewDefinition["layout"]`. */
type SavedLayout = NonNullable<ViewDefinition["layout"]>;

interface SavedViewsMenuProps {
  entity: Entity | undefined;
  columnFilters: ReadonlyArray<{ id: string; value: unknown }>;
  sorting: ReadonlyArray<{ id: string; desc: boolean }>;
  onApplyFilters: (filters: ViewDefinition["filters"]) => void;
  onApplySort: (sort: NonNullable<ViewDefinition["sort"]>) => void;
  onResetPage?: () => void;
  /** Tables apply exact layouts; dashboard/card consumers simply omit it. */
  onApplyLayout?: (layout: SavedLayout) => void;
  /** Sets the list view (`?view=`) and grouping (`?groupBy=`, `?groupLevel=`) a saved view opens with. */
  onApplyListSearch?: (patch: {
    view?: string;
    groupBy?: string;
    groupLevel?: number;
  }) => void;
}

/**
 * Applies a declared view's exact layout onto live table state.
 *
 * A view's layout is source-controlled (`view-manifest.ts`), not user input —
 * trust a non-empty slice as-is, falling back to the table's own computed
 * default for whichever slice the view leaves empty. `applyColumnLayout`
 * still guards the one invariant a view author could get wrong: the
 * row-actions menu never leaves the trailing edge.
 */
function applyTableLayout<TData extends RowData>(
  table: Table<TData>,
  savedLayout: SavedLayout,
) {
  const defaults = table.options.meta?.defaultLayout;
  if (!defaults) return;
  const { columnOrder, columnPinning, columnSizing } = savedLayout;
  applyColumnLayout(table, {
    columnOrder: columnOrder.length > 0 ? columnOrder : defaults.columnOrder,
    columnPinning: {
      start:
        columnPinning.start.length > 0
          ? columnPinning.start
          : defaults.columnPinning.start,
      end:
        columnPinning.end.length > 0
          ? columnPinning.end
          : defaults.columnPinning.end,
    },
    columnVisibility: {
      ...defaults.columnVisibility,
      ...savedLayout.columnVisibility,
    },
    columnSizing:
      Object.keys(columnSizing).length > 0
        ? columnSizing
        : defaults.columnSizing,
  });
}

/**
 * The same table-backed saved views, as bare menu items rather than a
 * standalone trigger — the `Actions ▾` menu (`data-table-toolbar.tsx`)
 * nests this inside its own `Saved views ▸` submenu.
 */
export function TableSavedViewsMenuItems<TData extends RowData>({
  table,
  entity,
}: DataTableViewsProps<TData>) {
  const appliers = useTableViewAppliers(table);
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const { columnFilters, sorting } = table.state;

  return (
    <SavedViewsMenuItems
      entity={entity}
      columnFilters={columnFilters}
      sorting={sorting}
      {...appliers}
    />
  );
}

type ViewAppliers = Pick<
  SavedViewsMenuProps,
  | "onApplyFilters"
  | "onApplySort"
  | "onApplyLayout"
  | "onApplyListSearch"
  | "onResetPage"
>;

/** How a table applies a declared view: its live state and the list URL. */
function useTableViewAppliers<TData extends RowData>(
  table: Table<TData>,
): ViewAppliers {
  const navigate = useNavigate();
  return {
    onApplyFilters: (filters) => table.setColumnFilters(filters),
    onApplySort: (sort) => table.setSorting(sort),
    onApplyLayout: (savedLayout) => applyTableLayout(table, savedLayout),
    onApplyListSearch: (patch) =>
      // SAFETY: as in `useListSearch`, route-specific search keys are erased;
      // every generated index route validates `view` and `groupBy`.
      void navigate({
        search: (previous: ListSearch) => ({ ...previous, ...patch }),
      } as never),
    onResetPage: () => table.setPageIndex(0),
  };
}

/** Sets a declared view's filters, sort, layout, list view and grouping. */
function applyView(
  view: ViewDefinition,
  {
    onApplyFilters,
    onApplySort,
    onApplyLayout,
    onApplyListSearch,
    onResetPage,
  }: ViewAppliers,
) {
  onApplyFilters(view.filters);
  if (view.sort) onApplySort(view.sort);
  // Layout does not participate in active-state matching: manual column
  // adjustments keep the view checked while its filter/sort contract holds.
  if (view.layout) onApplyLayout?.(view.layout);
  // Like layout, the list view and grouping stay out of active-state
  // matching; a view that declares neither leaves them as they are.
  const listSearch = {
    ...(view.view ? { view: view.view } : {}),
    ...(view.groupBy
      ? { groupBy: view.groupBy, groupLevel: view.groupLevel }
      : {}),
  };
  if (Object.keys(listSearch).length > 0) onApplyListSearch?.(listSearch);
  onResetPage?.();
}

const isListEntity = (entity: Entity | undefined): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);

/**
 * The entity's declared saved views as tabs under the list title, each with
 * its count, "All" first. The active tab is the view whose filters the list
 * holds; any other filter state leaves no tab selected. Absent when the
 * entity declares no views.
 */
export function SavedViewTabs<TData extends RowData>({
  table,
  entity,
}: DataTableViewsProps<TData>) {
  const appliers = useTableViewAppliers(table);
  const views = viewsForEntity(entity);
  const { total, counts } = useViewCounts(
    isListEntity(entity) ? entity : undefined,
  );
  if (views.length === 0) return null;
  const { columnFilters, sorting } = table.state;
  // Filters alone select a tab: a re-sorted view is still that view.
  const activeView = views.find((view) =>
    isViewActive(view, columnFilters, view.sort ?? sorting),
  );
  const allActive = activeView === undefined && columnFilters.length === 0;
  const tab = (
    key: string,
    label: string,
    count: number | undefined,
    active: boolean,
    onSelect: () => void,
    description?: string,
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      title={description}
      onClick={onSelect}
      className={cn(
        "-mb-px flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span className="text-muted-foreground tabular-nums">
          {formatCount(count)}
        </span>
      )}
    </button>
  );
  return (
    <nav
      aria-label="Saved views"
      className="flex min-w-0 [scrollbar-width:none] items-end gap-4 overflow-x-auto overscroll-x-contain"
    >
      {tab("all", "All", total, allActive, () => {
        appliers.onApplyFilters([]);
        appliers.onResetPage?.();
      })}
      {views.map((view) =>
        tab(
          view.id,
          view.label,
          counts.get(view.id),
          view === activeView,
          () => applyView(view, appliers),
          view.description,
        ),
      )}
    </nav>
  );
}

/** The link into the guided pass a view declares beside it. */
function ViewFlowMenuItem({
  flow,
}: {
  flow: NonNullable<ViewDefinition["flow"]>;
}) {
  return (
    <DropdownMenuItem
      render={<Link to="/inventory/triage" search={{ run: undefined }} />}
    >
      <ListChecksIcon className="size-3.5" />
      <span>{flow.label}</span>
    </DropdownMenuItem>
  );
}

/** The saved-view rows shared by the standalone menu and the `Actions ▾` submenu. */
function SavedViewsMenuItems({
  entity,
  columnFilters,
  sorting,
  onApplyFilters,
  onApplySort,
  onResetPage,
  onApplyLayout,
  onApplyListSearch,
}: SavedViewsMenuProps) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;
  const appliers = {
    onApplyFilters,
    onApplySort,
    onApplyLayout,
    onApplyListSearch,
    onResetPage,
  };

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Saved views</DropdownMenuLabel>
      {views.map((view) => {
        const active = isViewActive(view, columnFilters, sorting);
        return (
          <Fragment key={view.id}>
            <DropdownMenuItem onClick={() => applyView(view, appliers)}>
              <CheckIcon
                className={active ? "size-3.5" : "size-3.5 text-transparent"}
              />
              <Stack gap="tight">
                <span>{view.label}</span>
                <span className="text-xs text-muted-foreground">
                  {view.description}
                </span>
              </Stack>
            </DropdownMenuItem>
            {view.id === "research-queue" && (
              <DropdownMenuItem
                render={
                  <Link to="/work-queue" search={{ source: "research" }} />
                }
              >
                <ListChecksIcon className="size-3.5" />
                <span>Work queue</span>
              </DropdownMenuItem>
            )}
            {view.flow && <ViewFlowMenuItem flow={view.flow} />}
          </Fragment>
        );
      })}
    </DropdownMenuGroup>
  );
}

/** Saved-view chooser decoupled from TanStack so dashboards can share it. */
export function SavedViewsMenu(props: SavedViewsMenuProps) {
  if (viewsForEntity(props.entity).length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="default"
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        <BookmarkIcon className="size-3.5" />
        Saved views
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        <SavedViewsMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
