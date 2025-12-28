import type { Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import type { TableDensity } from "~/hooks/useTableDensity";
import { DataTableViewOptions } from "./data-table-view-options";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  /** Slot for additional content like summaries (e.g., "Value: $5,845.91") */
  additionalContent?: ReactNode;
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
}

export function DataTableToolbar<TData>({
  table,
  additionalContent,
  density,
  onDensityChange,
}: DataTableToolbarProps<TData>) {
  const isFiltered =
    table.getState().columnFilters.length > 0 || table.getState().globalFilter;

  return (
    <div className="flex items-center justify-between gap-2">
      <DataTableViewOptions
        table={table}
        density={density}
        onDensityChange={onDensityChange}
      />

      <div className="flex flex-1 items-center justify-end gap-2">
        {additionalContent}

        {isFiltered && (
          <Button
            variant="ghost"
            onClick={() => {
              table.resetColumnFilters();
              table.setGlobalFilter({});
            }}
            className="h-8 px-2 lg:px-3"
          >
            Reset
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}
