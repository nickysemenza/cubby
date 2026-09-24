import type { Entity } from "@cubby/schemas/entity";
import { BookmarkIcon } from "@phosphor-icons/react/dist/csr/Bookmark";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import type { RowData } from "@tanstack/react-table";

import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  isViewActive,
  type ViewDefinition,
  viewsForEntity,
} from "~/entities/view-manifest";

import { withLockedEndLast } from "./column-layout";
import type { CubbyTable as Table } from "./table-features";

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
}

/**
 * Applies a declared view's exact layout onto live table state.
 *
 * A view's layout is source-controlled (`view-manifest.ts`), not user input —
 * trust a non-empty slice as-is, falling back to the table's own computed
 * default for whichever slice the view leaves empty. `withLockedEndLast`
 * still guards the one invariant a view author could get wrong: the
 * row-actions menu never leaves the trailing edge.
 */
function applyTableLayout<TData extends RowData>(
  table: Table<TData>,
  savedLayout: SavedLayout,
) {
  const defaults = table.options.meta?.defaultLayout;
  if (!defaults) return;
  const actionColumnIds = new Set(
    table
      .getAllLeafColumns()
      .filter((column) => column.columnDef.meta?.entityColumnRole === "action")
      .map((column) => column.id),
  );
  table.setColumnOrder(
    savedLayout.columnOrder.length > 0
      ? withLockedEndLast(savedLayout.columnOrder, actionColumnIds)
      : defaults.columnOrder,
  );
  table.setColumnPinning({
    start:
      savedLayout.columnPinning.start.length > 0
        ? savedLayout.columnPinning.start
        : defaults.columnPinning.start,
    end:
      savedLayout.columnPinning.end.length > 0
        ? withLockedEndLast(savedLayout.columnPinning.end, actionColumnIds)
        : defaults.columnPinning.end,
  });
  table.setColumnVisibility({
    ...defaults.columnVisibility,
    ...savedLayout.columnVisibility,
  });
  table.setColumnSizing(
    Object.keys(savedLayout.columnSizing).length > 0
      ? savedLayout.columnSizing
      : defaults.columnSizing,
  );
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
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const { columnFilters, sorting } = table.state;

  return (
    <SavedViewsMenuItems
      entity={entity}
      columnFilters={columnFilters}
      sorting={sorting}
      onApplyFilters={(filters) => table.setColumnFilters(filters)}
      onApplySort={(sort) => table.setSorting(sort)}
      onApplyLayout={(savedLayout) => applyTableLayout(table, savedLayout)}
      onResetPage={() => table.setPageIndex(0)}
    />
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
}: SavedViewsMenuProps) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const applyView = (view: ViewDefinition) => {
    onApplyFilters(view.filters);
    if (view.sort) onApplySort(view.sort);
    // Layout does not participate in active-state matching: manual column
    // adjustments keep the view checked while its filter/sort contract holds.
    if (view.layout) onApplyLayout?.(view.layout);
    onResetPage?.();
  };

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Saved views</DropdownMenuLabel>
      {views.map((view) => {
        const active = isViewActive(view, columnFilters, sorting);
        return (
          <DropdownMenuItem key={view.id} onClick={() => applyView(view)}>
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
