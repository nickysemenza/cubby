import type { ColumnFiltersState } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import type { RuntimeFilterOptions } from "~/app/_components/hooks/filter-option-types";
import {
  type FilterSpec,
  manifestFilterFields,
} from "~/entities/filter-manifest";
import { decodeFilters, encodeFilters } from "~/entities/filters";
import { cn } from "~/lib/utils";

import { filterStateToBarFilters } from "./filter-bar-core";
import { FilterBar } from "./FilterBar";
import { useFilterBarDraft } from "./useFilterBarDraft";

interface ManifestFilterBarProps {
  specs: readonly FilterSpec[];
  /** Runtime picklists keyed by each spec's `optionsKey`. */
  filterOptions?: RuntimeFilterOptions;
  /** Current route search params. */
  search: Record<string, unknown>;
  onSearchChange: (params: Record<string, string | undefined>) => void;
  className?: string;
}

/**
 * The URL-backed manifest filter bar, for a page with no table under it.
 *
 * `LedgerFilters` is the table-backed twin; both render the same reui
 * `<Filters>` over `useFilterBarDraft`, so they cannot drift in chrome,
 * debounce behavior, or reconciliation. The only difference is where state
 * lives — column filters there, search params here.
 *
 * `decodeFilters` is the ONLY reader of URL state, which is also what
 * `filterGetterFromSearch` uses to build the operation input: the bar and the query
 * therefore cannot disagree about what the URL says.
 */
export function ManifestFilterBar({
  specs,
  filterOptions,
  search,
  onSearchChange,
  className,
}: ManifestFilterBarProps) {
  const fields = useMemo(
    () => manifestFilterFields(specs, filterOptions),
    [specs, filterOptions],
  );
  const externalFilters = useMemo(
    () => filterStateToBarFilters(decodeFilters(specs, search), fields),
    [specs, search, fields],
  );
  const commit = useCallback(
    (columnFilters: ColumnFiltersState) =>
      // `encodeFilters` emits `undefined` (never "") for a cleared key, which
      // is what `stripSearchParams` needs to drop it from the URL entirely.
      onSearchChange(
        encodeFilters(
          specs,
          (columnId) =>
            columnFilters.find((filter) => filter.id === columnId)?.value as
              | string
              | string[]
              | undefined,
        ),
      ),
    [onSearchChange, specs],
  );
  const { draftFilters, handleChange } = useFilterBarDraft({
    externalFilters,
    fields,
    commit,
  });

  if (fields.length === 0) return null;

  return (
    <FilterBar
      filters={draftFilters}
      fields={fields}
      onChange={handleChange}
      className={cn("min-w-0", className)}
    />
  );
}
