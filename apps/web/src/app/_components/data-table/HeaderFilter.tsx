import { useDebouncedValue } from "@tanstack/react-pacer";
import type { Column } from "@tanstack/react-table";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FilterableCombobox,
  MultiFilterableCombobox,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import type { FilterConfig } from "./columnHelpers";

interface HeaderFilterProps<TData> {
  column: Column<TData, unknown>;
  filterConfig: FilterConfig;
}

/** A column filter holds either a scalar or, for multiselect, a set. */
type FilterState = string | string[];

/**
 * Stable empty selection. A fresh `[]` per render would make the
 * external-change check below fire every time (arrays compare by reference),
 * which sets state during render — an unbreakable re-render loop.
 */
const NO_SELECTION: string[] = [];

/** Order-insensitive-free identity for change detection. */
const stateKey = (value: FilterState): string =>
  Array.isArray(value) ? value.join("\0") : value;

export function HeaderFilter<TData>({
  column,
  filterConfig,
}: HeaderFilterProps<TData>) {
  const isMulti = filterConfig.filterType === "multiselect";

  // Get external filter value (from table state, e.g., after reset)
  const raw = column.getFilterValue();
  const externalValue: FilterState = isMulti
    ? Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string" && raw
        ? [raw]
        : NO_SELECTION
    : ((raw as string) ?? "");

  const [value, setValue] = useState<FilterState>(externalValue);
  const [debouncedValue] = useDebouncedValue(value, { wait: 500 });

  // Track last synced external value to detect external changes. Held as a
  // serialized KEY, never the value — see NO_SELECTION.
  const lastExternalRef = useRef(stateKey(externalValue));

  // Apply debounced value to column filter
  // CRITICAL: column is NOT in deps - it's a stable API reference from TanStack
  // Including it causes infinite rerenders when table recreates column objects
  // biome-ignore lint/correctness/useExhaustiveDependencies: column is intentionally excluded to prevent infinite rerenders
  useEffect(() => {
    // An empty selection must clear the filter, not store `[]`. `[] || undefined`
    // is `[]` (arrays are truthy), which would leave the column in
    // `columnFilters` forever — the toolbar would keep showing "Reset", the
    // empty state would keep claiming the table is filtered, and client-side
    // tables would run the filterFn against an empty set and drop every row.
    const next = Array.isArray(debouncedValue)
      ? debouncedValue.length
        ? debouncedValue
        : undefined
      : debouncedValue || undefined;
    // Record what WE wrote before writing it. Otherwise the external-change
    // check below sees the column catch up to this (already stale) value and
    // mistakes our own write for an outside one, clobbering anything the user
    // picked in the meantime — which is exactly a second multi-select choice
    // made while the first was still settling.
    lastExternalRef.current = stateKey(debouncedValue);
    column.setFilterValue(next);
  }, [debouncedValue]);

  // Sync external changes (e.g., reset button clears filters)
  const externalKey = stateKey(externalValue);
  if (externalKey !== lastExternalRef.current) {
    lastExternalRef.current = externalKey;
    if (externalKey !== stateKey(value)) {
      setValue(externalValue);
    }
  }

  // Dense filter row: flatten the global chunky input treatment (drop the 2px
  // border + offset shadow) so dozens of tiny filters don't read as heavy boxes.
  const inputClassName =
    "h-5 text-2xs px-1.5 border shadow-none bg-background border-border placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:border-primary/40"; /* tight */

  // Enrich select options with faceted counts (opt-in — see FilterConfig).
  // biome-ignore lint/correctness/useExhaustiveDependencies: column.getFacetedUniqueValues is stable API
  const facetedOptions = useMemo(() => {
    const isSelectLike =
      filterConfig.filterType === "select" ||
      filterConfig.filterType === "multiselect";
    if (!isSelectLike || !filterConfig.options) return [];
    if (!filterConfig.facetCount) return filterConfig.options;
    let facetMap: Map<string, number>;
    try {
      facetMap = column.getFacetedUniqueValues();
    } catch {
      return filterConfig.options;
    }
    if (!facetMap.size) return filterConfig.options;
    return filterConfig.options.map((opt) => {
      // `hint`, not `label` — the label is interpolated into filter chips and
      // the collapsed multi-select summary, and drives the type-ahead match.
      const count = facetMap.get(opt.value);
      return count !== undefined ? { ...opt, hint: String(count) } : opt;
    });
  }, [filterConfig.options, filterConfig.filterType, filterConfig.facetCount]);

  if (filterConfig.filterType === "select" || isMulti) {
    // A select filter lives in a narrow column behind a chevron, and the
    // combobox's <input> clips its placeholder with no ellipsis ("Filter by
    // s"). Strip the verbose lead-in down to the bare noun ("status"). The full
    // string stays on the config — `createFilterableSelectColumn` reuses it for
    // the inline cell editor, where the long form reads right.
    //
    // Both lead-ins: the presence filters say "Filter images..." rather than
    // "Filter by images...", and without the bare-"filter" arm those clipped to
    // a single letter in their (deliberately narrow) columns.
    const shortPlaceholder = filterConfig.placeholder
      .replace(/^filter\s+(by\s+)?/i, "")
      .replace(/(\.{3}|…)$/, "");

    if (isMulti) {
      return (
        <MultiFilterableCombobox
          items={facetedOptions}
          value={Array.isArray(value) ? value : value ? [value] : NO_SELECTION}
          onValueChange={setValue}
          placeholder={shortPlaceholder}
          className={`w-full ${inputClassName}`}
        />
      );
    }

    return (
      <FilterableCombobox
        items={facetedOptions}
        value={typeof value === "string" && value ? value : null}
        onValueChange={(v) => setValue(v ?? "")}
        placeholder={shortPlaceholder}
        // Every select filter is optional by definition — "no filter" is the
        // default state, so it must be reachable without the toolbar's Reset
        // (which clears EVERY column at once). This replaces the per-page
        // `{ value: "", label: "All …" }` sentinel options pages used to
        // hand-roll one filter at a time.
        clearable
        className={`w-full ${inputClassName}`}
      />
    );
  }

  const textValue = typeof value === "string" ? value : "";
  return (
    <div className="relative">
      <Input
        placeholder={filterConfig.placeholder}
        value={textValue}
        onChange={(e) => setValue(e.target.value)}
        className={`w-full ${inputClassName} ${textValue ? "pr-6" : ""}`}
        onClick={(e) => e.stopPropagation()}
      />
      {textValue && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={(e) => {
            e.stopPropagation();
            setValue("");
          }}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="size-2.5" />
        </button>
      )}
    </div>
  );
}
