import {
  FILTER_ALL,
  FILTER_ANY,
  FILTER_EXACT,
} from "@cubby/schemas/filter-sentinel-fields";
import type { ColumnFiltersState } from "@tanstack/react-table";

import { colorizeSelectOptions } from "~/lib/select-options";
import type { PickerOption } from "~/ui/combobox/picker-option";
import type { FilterConfig } from "~/ui/data-table/table-meta";

type FilterOption = PickerOption;

export type FilterFieldConfig = {
  key: string;
  label?: string;
  type: "text" | "select" | "multiselect";
  options?: FilterOption[];
  placeholder?: string;
  inputType?: "text" | "number" | "date";
  min?: number;
  max?: number;
  description?: string;
  /** Offers Match any | Match all (multi-valued fields only). */
  matchAll?: boolean;
  /** The "Include sub-…" toggle inside a hierarchical reference's editor. */
  subtree?: { label: string };
  onActivate?: (selectedIds?: readonly string[]) => void;
  onSearchChange?: (query: string) => void;
  isLoading?: boolean;
};

export type Filter = {
  id: string;
  field: string;
  operator: string;
  values: string[];
};

/**
 * The table-agnostic half of the manifest filter bar.
 *
 * Tables and the calendar render the shared `FilterBar` over the same filter
 * manifest: the ledger tables, whose state lives in TanStack's
 * `columnFilters`, and the calendar, whose state lives in the URL. Only the
 * field derivation and the read/write ends differ — the adapters and the
 * draft/debounce machine below are identical, and a second hand-written copy
 * of them is exactly the drift the manifest exists to prevent.
 *
 * `ColumnFiltersState` is used as the neutral currency here rather than a
 * table concept: it is structurally `{id, value}[]`, which is also what
 * `decodeFilters` returns and what `filterGetterFromColumnFilters` reads.
 */

export type FilterBarField = FilterFieldConfig;

/** The operator a bare `values[]` implies for a field's declared type. */
export function operatorFor(field: FilterBarField): string {
  if (field.type === "text") return "contains";
  if (field.type === "multiselect") return "is_any_of";
  return "is";
}

/** Editor modes riding in a value list: they shape a pick but are not one. */
const MODE_TOKENS: ReadonlySet<string> = new Set([FILTER_ALL, FILTER_EXACT]);

/** A filter is active (counts toward "Clear N", tints its chip) once it has a real value. */
export function hasFilterValue(filter: Filter): boolean {
  return filter.values.some((value) => value !== "" && !MODE_TOKENS.has(value));
}

/**
 * A picker change to a value filter, under the Any value rule: picking Any
 * value clears the specific values (it already includes them), and picking
 * anything else clears Any value. No value combines with specific values.
 * Mode tokens (Match all, Include sub-… off) carry through untouched.
 */
export function nextPickedValues(
  previous: readonly string[],
  picked: readonly string[],
): string[] {
  const modes = previous.filter((value) => MODE_TOKENS.has(value));
  const added = picked.filter((value) => !previous.includes(value));
  const values = added.includes(FILTER_ANY)
    ? [FILTER_ANY]
    : added.length > 0
      ? picked.filter((value) => value !== FILTER_ANY)
      : [...picked];
  return [...values, ...modes];
}

/** The values a picker shows: every value except the editor's mode tokens. */
export const pickerValues = (values: readonly string[]): string[] =>
  values.filter((value) => !MODE_TOKENS.has(value));

/** Sets or clears one mode token in a value list. */
export const withMode = (
  values: readonly string[],
  token: typeof FILTER_ALL | typeof FILTER_EXACT,
  on: boolean,
): string[] => [
  ...values.filter((value) => value !== token),
  ...(on ? [token] : []),
];

export function filterStateToBarFilters(
  columnFilters: ColumnFiltersState,
  fields: FilterBarField[],
): Filter[] {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  return columnFilters.flatMap((columnFilter) => {
    const field = fieldsByKey.get(columnFilter.id);
    if (!field) return [];
    const values = Array.isArray(columnFilter.value)
      ? columnFilter.value.map(String)
      : columnFilter.value == null || columnFilter.value === ""
        ? []
        : [String(columnFilter.value)];
    if (values.length === 0) return [];
    return [
      {
        id: `ledger-${columnFilter.id}`,
        field: columnFilter.id,
        operator: operatorFor(field),
        values,
      },
    ];
  });
}

export function barFiltersToFilterState(
  filters: Filter[],
  fields: FilterBarField[],
): ColumnFiltersState {
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
  return filters.flatMap((filter) => {
    const field = fieldsByKey.get(filter.field);
    if (!field) return [];
    const values = filter.values.filter((value) => value !== "");
    if (values.length === 0) return [];
    return [
      {
        id: filter.field,
        value: field.type === "multiselect" ? values : values[0],
      },
    ];
  });
}

export const filterStateKey = (filters: Filter[]): string =>
  JSON.stringify(
    filters
      .map(({ field, operator, values }) => ({ field, operator, values }))
      .sort((left, right) => left.field.localeCompare(right.field)),
  );

export function normalizeBarFilters(
  filters: Filter[],
  fields: FilterBarField[],
) {
  const columnFilters = barFiltersToFilterState(filters, fields);
  return {
    columnFilters,
    externalKey: filterStateKey(filterStateToBarFilters(columnFilters, fields)),
  };
}

/**
 * One filter-bar field from a resolved {@link FilterConfig}. The label is passed in
 * rather than read off the source: a table takes it from the column header, a
 * manifest-only bar from the spec's `label`, and neither can see the other's.
 */
export function barFieldFromConfig(
  key: string,
  label: string,
  config: FilterConfig,
  optionHints?: Readonly<Record<string, string>>,
): FilterBarField {
  const type = config.filterType ?? "text";
  return {
    key,
    label,
    type,
    placeholder: type === "text" ? `Filter ${label.toLowerCase()}…` : undefined,
    options: config.options
      ? colorizeSelectOptions(config.options).map((option) => ({
          ...option,
          hint: optionHints?.[option.value] ?? option.hint,
        }))
      : undefined,
    matchAll: config.matchAll,
    subtree: config.subtree,
    onActivate: config.onActivate,
    onSearchChange: config.onSearchChange,
    isLoading: config.isLoading,
  };
}
