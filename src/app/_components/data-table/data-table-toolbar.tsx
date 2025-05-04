"use client";

import { type Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DataTableViewOptions } from "./data-table-view-options";
import { type ReactNode } from "react";

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  additionalFilters?: ReactNode;
  filterableColumns: {
    id: string;
    placeholder: string;
  }[];
}

export function DataTableToolbar<TData>({
  table,
  additionalFilters,
  filterableColumns,
}: DataTableToolbarProps<TData>) {
  const isFiltered =
    table.getState().columnFilters.length > 0 || table.getState().globalFilter;

  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-1 items-center space-x-2">
        {filterableColumns?.map((column) => {
          // Check if this column exists in the table
          const isColumnAvailable = table
            .getAllColumns()
            .map((c) => c.id)
            .includes(column.id);

          if (!isColumnAvailable) return null;

          return (
            <Input
              key={column.id}
              placeholder={column.placeholder}
              value={(table.getColumn(column.id)?.getFilterValue() as string) ?? ""}
              onChange={(event) =>
                table.getColumn(column.id)?.setFilterValue(event.target.value)
              }
              className="h-8 w-[150px] lg:w-[250px]"
            />
          );
        })}

        {additionalFilters}

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
      <DataTableViewOptions table={table} />
    </div>
  );
}
