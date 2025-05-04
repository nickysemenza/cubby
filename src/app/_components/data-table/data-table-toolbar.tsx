"use client";

import { RowData, type Table } from "@tanstack/react-table";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "~/components/ui/select";
import { DataTableViewOptions } from "./data-table-view-options";
import { type ReactNode, useState, useEffect } from "react";
import useDebounce from "~/misc/useDebounce";

interface FilterOption {
  value: string;
  label: string;
}

interface FilterableColumn {
  id: string;
  placeholder: string;
  filterType?: "text" | "select";
  options?: FilterOption[];
}

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  additionalFilters?: ReactNode;
  filterableColumns: FilterableColumn[];
}

// Text input filter component
const TextFilterInput = <TData extends RowData>({
  column,
  table,
  value,
  onChange,
}: {
  column: FilterableColumn;
  table: Table<TData>;
  value: string;
  onChange: (value: string) => void;
}) => {
  // Apply debouncing at the individual filter level
  const debouncedValue = useDebounce(value, 500);

  // Set the filter on the table when the debounced value changes
  useEffect(() => {
    table.getColumn(column.id)?.setFilterValue(debouncedValue);
  }, [debouncedValue, column.id, table]);

  return (
    <Input
      placeholder={column.placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 w-[150px] lg:w-[250px]"
    />
  );
};

// Select dropdown filter component
const SelectFilterInput = <TData extends RowData>({
  column,
  table,
  value,
  onChange,
}: {
  column: FilterableColumn;
  table: Table<TData>;
  value: string;
  onChange: (value: string) => void;
}) => {
  // Apply debouncing at the individual filter level
  const debouncedValue = useDebounce(value, 500);

  // Set the filter on the table when the debounced value changes
  useEffect(() => {
    table.getColumn(column.id)?.setFilterValue(debouncedValue || undefined);
  }, [debouncedValue, column.id, table]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[150px] lg:w-[200px]">
        <SelectValue placeholder={column.placeholder} />
      </SelectTrigger>
      <SelectContent>
        {column.options?.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

// Filter component that renders the appropriate input type
const FilterInput = <TData extends RowData>({
  column,
  table,
  value,
  onChange,
}: {
  column: FilterableColumn;
  table: Table<TData>;
  value: string;
  onChange: (value: string) => void;
}) => {
  // Render select dropdown if specified, otherwise default to text input
  if (column.filterType === "select") {
    return (
      <SelectFilterInput<TData>
        column={column}
        table={table}
        value={value}
        onChange={onChange}
      />
    );
  }

  // Default to text input
  return (
    <TextFilterInput<TData>
      column={column}
      table={table}
      value={value}
      onChange={onChange}
    />
  );
};

export function DataTableToolbar<TData>({
  table,
  additionalFilters,
  filterableColumns,
}: DataTableToolbarProps<TData>) {
  // Track the input values locally for immediate UI feedback
  const [filterInputs, setFilterInputs] = useState<Record<string, string>>({});

  // Initialize the filter inputs with the current filter values
  useEffect(() => {
    const initialFilters: Record<string, string> = {};
    filterableColumns?.forEach((column) => {
      const columnValue = table
        .getColumn(column.id)
        ?.getFilterValue() as string;
      if (columnValue) {
        initialFilters[column.id] = columnValue;
      }
    });
    setFilterInputs(initialFilters);
  }, [filterableColumns, table]);

  const isFiltered =
    table.getState().columnFilters.length > 0 || table.getState().globalFilter;

  // Create an array of available columns outside the JSX
  const availableColumns =
    filterableColumns?.filter((column) =>
      table
        .getAllColumns()
        .map((c) => c.id)
        .includes(column.id),
    ) || [];

  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-1 items-center space-x-2">
        {availableColumns.map((column) => (
          <FilterInput<TData>
            key={column.id}
            column={column}
            table={table}
            value={filterInputs[column.id] || ""}
            onChange={(newValue) => {
              setFilterInputs((prev) => ({
                ...prev,
                [column.id]: newValue,
              }));
            }}
          />
        ))}

        {additionalFilters}

        {isFiltered && (
          <Button
            variant="ghost"
            onClick={() => {
              // Reset both the table filters and our local state
              table.resetColumnFilters();
              table.setGlobalFilter({});
              setFilterInputs({});
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
