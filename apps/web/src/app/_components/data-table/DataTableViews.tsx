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
  /**
   * Reveal the columns a view selects on. Optional because the decoupled
   * consumers (the projects dashboard) render cards, not columns — a view with
   * a `columnVisibility` block simply has nothing to reveal there.
   */
  onApplyColumnVisibility?: (
    visibility: NonNullable<ViewDefinition["columnVisibility"]>,
  ) => void;
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
      onApplyColumnVisibility={(visibility) =>
        // Merged, not replaced: a view names only the columns it needs to
        // reveal, and everything else stays as the user left it.
        table.setColumnVisibility((current) => ({ ...current, ...visibility }))
      }
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
  onApplyColumnVisibility,
}: SavedViewsMenuProps) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const applyView = (view: ViewDefinition) => {
    onApplyFilters(view.filters);
    if (view.sort) onApplySort(view.sort);
    // Before the page reset, so the revealed columns are already on when the
    // first page renders.
    if (view.columnVisibility) onApplyColumnVisibility?.(view.columnVisibility);
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
        Views
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
