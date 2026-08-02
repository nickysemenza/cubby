import type { Entity } from "@cubby/schemas/entity";
import type { Table } from "@tanstack/react-table";
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

interface DataTableViewsProps<TData> {
  table: Table<TData>;
  entity: Entity | undefined;
}

/**
 * Saved-view menu for a list table. Renders nothing for an entity with no
 * declared views, so every other table is untouched.
 *
 * Applying a view sets table STATE. `useTableState` writes that controlled
 * state through to the URL, while external navigation is reconciled back into
 * the table. That keeps views, shared links, and Back/Forward equivalent.
 */
export function DataTableViews<TData>({
  table,
  entity,
}: DataTableViewsProps<TData>) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return null;

  const { columnFilters, sorting } = table.getState();

  const applyView = (view: ViewDefinition) => {
    table.setColumnFilters(view.filters);
    if (view.sort) table.setSorting(view.sort);
    // Belt-and-braces: setColumnFilters already resets the page (see
    // useTableState), but a view that only changes the sort wouldn't, and
    // landing on page 3 of a different result set shows an empty table.
    table.setPageIndex(0);
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
