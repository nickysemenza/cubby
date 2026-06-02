import type { Column } from "@tanstack/react-table";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  // CRITICAL: column is NOT in deps - it's a stable API reference from TanStack Table
  // Including it causes infinite rerenders when table recreates column objects
  // biome-ignore lint/correctness/useExhaustiveDependencies: column is intentionally excluded to prevent infinite rerenders
  useEffect(() => {
    column.setFilterValue(debouncedValue || undefined);
  }, [debouncedValue]);

  // Sync external changes (e.g., reset button clears filters)
  if (externalValue !== lastExternalRef.current) {
    lastExternalRef.current = externalValue;
    if (externalValue !== value) {
      setValue(externalValue);
    }
  }

  const inputClassName =
    "h-5 text-2xs px-1.5 bg-background/80 border-border/60 placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40";

  // Enrich select options with faceted counts
  // biome-ignore lint/correctness/useExhaustiveDependencies: column.getFacetedUniqueValues is stable API
  const facetedOptions = useMemo(() => {
    if (filterConfig.filterType !== "select" || !filterConfig.options)
      return [];
    let facetMap: Map<string, number>;
    try {
      facetMap = column.getFacetedUniqueValues();
    } catch {
      return filterConfig.options;
    }
    if (!facetMap.size) return filterConfig.options;
    return filterConfig.options.map((opt) => {
      const count = facetMap.get(opt.value);
      return count !== undefined
        ? { ...opt, label: `${opt.label} (${count})` }
        : opt;
    });
  }, [filterConfig.options, filterConfig.filterType]);

  if (filterConfig.filterType === "select") {
    return (
      <FilterableCombobox
        items={facetedOptions}
        value={value || null}
        onValueChange={(v) => v && setValue(v)}
        placeholder={filterConfig.placeholder}
        className={`w-full ${inputClassName}`}
      />
    );
  }

  return (
    <div className="relative">
      <Input
        placeholder={filterConfig.placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`w-full ${inputClassName} ${value ? "pr-5" : ""}`}
        onClick={(e) => e.stopPropagation()}
      />
      {value && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setValue("");
          }}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
