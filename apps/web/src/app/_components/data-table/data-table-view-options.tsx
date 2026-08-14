import type { Column, Table } from "@tanstack/react-table";
import {
  AlignJustify,
  Columns3,
  LayoutList,
  List,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { humanize } from "~/entities/filters";
import { type TableDensity, useTableDensity } from "./useTableDensity";

const densityOptions: {
  value: TableDensity;
  label: string;
  icon: typeof List;
}[] = [
  { value: "comfortable", label: "Comfortable", icon: List },
  { value: "compact", label: "Compact", icon: LayoutList },
  { value: "dense", label: "Dense", icon: AlignJustify },
];

interface DataTableViewOptionsProps<TData> {
  table: Table<TData>;
  /**
   * Clear this table's persisted column widths. Passed only when the user has
   * actually resized something, so the item stays out of the menu on a table
   * still at its code-defined widths.
   */
  onResetColumnWidths?: () => void;
}

/**
 * Same derivation `LedgerFilters` uses: a column's own string `header` reads
 * better than its raw id ("Data quality", not "dataQuality"), and `humanize`
 * is only the fallback for headers that aren't plain strings (icons, JSX).
 * Column meta has no other honest signal to group columns by — `mobile.slot`
 * (title/subtitle/meta/trailing) exists to place fields on a phone card, not
 * to categorize a settings menu, and on `/products` it's unset (implicit
 * "hidden") for roughly half the columns, so grouping by it would dump most
 * of the list into one meaningless bucket. Search is what makes 26 items
 * navigable instead.
 */
export function columnLabel<TData>(column: Column<TData, unknown>): string {
  const header = column.columnDef.header;
  return typeof header === "string" ? header : humanize(column.id);
}

export function DataTableViewOptions<TData>({
  table,
  onResetColumnWidths,
}: DataTableViewOptionsProps<TData>) {
  const { density, setDensity } = useTableDensity();
  const [columnSearch, setColumnSearch] = useState("");

  const toggleableColumns = table
    .getAllColumns()
    .filter(
      (column) =>
        typeof column.accessorFn !== "undefined" && column.getCanHide(),
    );
  const query = columnSearch.trim().toLowerCase();
  const visibleColumns = query
    ? toggleableColumns.filter((column) =>
        columnLabel(column).toLowerCase().includes(query),
      )
    : toggleableColumns;

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
        <Settings2 className="size-3.5" />
        View
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[240px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(v) => setDensity(v as TableDensity)}
          >
            {densityOptions.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                <opt.icon className="mr-2 size-3.5" />
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {onResetColumnWidths && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onResetColumnWidths}>
                <Columns3 className="mr-2 size-3.5" />
                Reset column widths
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
          <div className="px-2 pb-1.5" /* tight */>
            <Input
              value={columnSearch}
              onChange={(e) => setColumnSearch(e.target.value)}
              onKeyDown={(e) => {
                // The menu's roving focus otherwise eats every keystroke as
                // typeahead navigation instead of letting it reach the input.
                if (e.key !== "Escape") e.stopPropagation();
              }}
              placeholder="Search columns…"
              className="h-6 text-xs"
            />
          </div>
          <DropdownMenuItem onClick={() => table.setColumnVisibility({})}>
            <RotateCcw className="mr-2 size-3.5" />
            Reset to default
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {visibleColumns.length === 0 ? (
            <div
              className="px-2 py-1.5 text-muted-foreground text-xs" /* tight */
            >
              No columns match "{columnSearch}".
            </div>
          ) : (
            visibleColumns.map((column) => {
              return (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {columnLabel(column)}
                </DropdownMenuCheckboxItem>
              );
            })
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
