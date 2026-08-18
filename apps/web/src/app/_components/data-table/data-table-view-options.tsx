import type { RowData } from "@tanstack/react-table";
import { AlignJustify, LayoutList, List, Settings2 } from "lucide-react";
import { lazy, Suspense } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { humanize } from "~/entities/filters";
import type {
  CubbyColumn as Column,
  CubbyTable as Table,
} from "./table-features";
import { type TableDensity, useTableDensity } from "./useTableDensity";

const TableLayoutCustomizer = lazy(() => import("./TableLayoutCustomizer"));

const densityOptions: {
  value: TableDensity;
  label: string;
  icon: typeof List;
}[] = [
  { value: "comfortable", label: "Comfortable", icon: List },
  { value: "compact", label: "Compact", icon: LayoutList },
  { value: "dense", label: "Dense", icon: AlignJustify },
];

interface DataTableViewOptionsProps<TData extends RowData> {
  table: Table<TData>;
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
export function columnLabel<TData extends RowData>(
  column: Column<TData, unknown>,
): string {
  const header = column.columnDef.header;
  return typeof header === "string" ? header : humanize(column.id);
}

export function DataTableViewOptions<TData extends RowData>({
  table,
}: DataTableViewOptionsProps<TData>) {
  const { density, setDensity } = useTableDensity();

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
      <DropdownMenuContent
        align="end"
        className="max-h-[75vh] w-[480px] overflow-y-auto"
      >
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
        <DropdownMenuSeparator />
        <Suspense
          fallback={
            <div className="p-4 text-center text-muted-foreground text-xs">
              Loading layout controls…
            </div>
          }
        >
          <TableLayoutCustomizer table={table as unknown as Table<RowData>} />
        </Suspense>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
