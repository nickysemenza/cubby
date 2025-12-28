import type { Column } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import useDebounce from "~/hooks/useDebounce";
import type { FilterConfig } from "./columnHelpers";

interface HeaderFilterProps<TData> {
  column: Column<TData, unknown>;
  filterConfig: FilterConfig;
  isDense?: boolean;
}

export function HeaderFilter<TData>({
  column,
  filterConfig,
  isDense = false,
}: HeaderFilterProps<TData>) {
  // Get external filter value (from table state, e.g., after reset)
  const externalValue = (column.getFilterValue() as string) ?? "";

  const [value, setValue] = useState<string>(externalValue);
  const debouncedValue = useDebounce(value, 500);

  // Track last synced external value to detect external changes
  const lastExternalRef = useRef(externalValue);

  // Apply debounced value to column filter
  useEffect(() => {
    column.setFilterValue(debouncedValue || undefined);
  }, [debouncedValue, column]);

  // Sync external changes (e.g., reset button clears filters)
  if (externalValue !== lastExternalRef.current) {
    lastExternalRef.current = externalValue;
    if (externalValue !== value) {
      setValue(externalValue);
    }
  }

  const inputClassName = isDense ? "h-5 text-[10px] px-1" : "h-7 text-xs px-2";

  if (filterConfig.filterType === "select") {
    return (
      <Select value={value} onValueChange={(v) => v && setValue(v)}>
        <SelectTrigger className={`w-full ${inputClassName}`}>
          <SelectValue placeholder={filterConfig.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {filterConfig.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Input
      placeholder={filterConfig.placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className={`w-full ${inputClassName}`}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
