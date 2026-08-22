import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import { Bookmark, Check } from "lucide-react";
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
import type { CubbyTable as Table } from "./table-features";
import {
  type CubbySavedTableLayout,
  normalizeTableLayout,
} from "./table-layout";

interface DataTableViewsProps<TData extends RowData> {
  table: Table<TData>;
  entity: Entity | undefined;
}

interface SavedViewsMenuProps {
  entity: Entity | undefined;
  columnFilters: ReadonlyArray<{ id: string; value: unknown }>;
  sorting: ReadonlyArray<{ id: string; desc: boolean }>;
  onApplyFilters: (filters: ViewDefinition["filters"]) => void;
  onApplySort: (sort: NonNullable<ViewDefinition["sort"]>) => void;
  onResetPage?: () => void;
  /** Tables apply exact layouts; dashboard/card consumers simply omit it. */
  onApplyLayout?: (layout: CubbySavedTableLayout) => void;
}

/**
 * Saved-view menu for a list table. Renders nothing for an entity with no
 * declared views, so every other table is untouched.
 *
 * Applying a view sets table STATE. `useTableState` writes that controlled
 * state through to the URL, while external navigation is reconciled back into
 * the table. That keeps views, shared links, and Back/Forward equivalent.
 */
export function DataTableViews<TData extends RowData>({
  table,
  entity,
}: DataTableViewsProps<TData>) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const { columnFilters, sorting } = table.state;

  return (
    <SavedViewsMenu
      entity={entity}
      columnFilters={columnFilters}
      sorting={sorting}
      onApplyFilters={(filters) => table.setColumnFilters(filters)}
      onApplySort={(sort) => table.setSorting(sort)}
      onApplyLayout={(savedLayout) => {
        const defaults = table.options.meta?.defaultLayout;
        if (!defaults) return;
        const layout = normalizeTableLayout(
          {
            ...defaults,
            ...savedLayout,
            columnPinning: {
              start: savedLayout.columnPinning?.start ?? [],
              end: savedLayout.columnPinning?.end ?? [],
            },
            columnVisibility: {
              ...defaults.columnVisibility,
              ...savedLayout.columnVisibility,
            },
            columnSizing: savedLayout.columnSizing ?? {},
          },
          defaults,
        );
        table.setColumnOrder(layout.columnOrder);
        table.setColumnPinning(layout.columnPinning);
        table.setColumnVisibility(layout.columnVisibility);
        table.setColumnSizing(layout.columnSizing);
      }}
      onResetPage={() => table.setPageIndex(0)}
    />
  );
}

/** Saved-view chooser decoupled from TanStack so dashboards can share it. */
export function SavedViewsMenu({
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
        <Bookmark className="size-3.5" />
        Saved views
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {views.map((view) => {
            const active = isViewActive(view, columnFilters, sorting);
            return (
              <DropdownMenuItem key={view.id} onClick={() => applyView(view)}>
                <Check
                  className={active ? "size-3.5" : "size-3.5 text-transparent"}
                />
                <Stack gap="tight">
                  <span>{view.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {view.description}
                  </span>
                </Stack>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
