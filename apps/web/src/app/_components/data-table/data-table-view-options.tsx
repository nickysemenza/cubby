import type { Table } from "@tanstack/react-table";
import {
  AlignJustify,
  Columns3,
  LayoutList,
  List,
  Settings2,
} from "lucide-react";

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

export function DataTableViewOptions<TData>({
  table,
  onResetColumnWidths,
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
      <DropdownMenuContent align="end" className="w-[170px]">
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
          {table
            .getAllColumns()
            .filter(
              (column) =>
                typeof column.accessorFn !== "undefined" && column.getCanHide(),
            )
            .map((column) => {
              return (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {column.id}
                </DropdownMenuCheckboxItem>
              );
            })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
