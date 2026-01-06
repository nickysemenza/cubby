import type { Column } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import useDebounce from "~/hooks/useDebounce";
import type { FilterConfig } from "./columnHelpers";

interface HeaderFilterProps<TData> {
  column: Column<TData, unknown>;
  filterConfig: FilterConfig;
}

export function HeaderFilter<TData>({
  column,
  filterConfig,
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

  const inputClassName =
    "h-5 text-[10px] px-1.5 bg-background/80 border-border/60 placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40";

  if (filterConfig.filterType === "select") {
    return (
      <FilterableCombobox
        items={filterConfig.options ?? []}
        value={value || null}
        onValueChange={(v) => v && setValue(v)}
        placeholder={filterConfig.placeholder}
        className={`w-full ${inputClassName}`}
      />
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
