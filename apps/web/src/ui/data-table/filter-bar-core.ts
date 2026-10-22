import {
  FILTER_ALL,
  FILTER_ANY,
  FILTER_EXACT,
  FILTER_NOT_PREFIX,
  splitExcluded,
} from "@cubby/schemas/filter-sentinel-fields";
import type { NumberRange } from "@cubby/shared";
import type { ColumnFiltersState } from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { PickerRecordSource } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import type { FilterConfig } from "~/ui/data-table/table-meta";

type FilterOption = PickerOption;

/**
 * What a filter's values are, carried from the declared filter kind so the
 * panel can show a type glyph and pick the editor: a checklist for `enum` and
 * `entity`, Any | Yes | No for `boolean` and `presence`, bounds for `date` and
 * `number`, an input for `text`.
 */
export type FilterValueType =
  | "text"
  | "enum"
  | "entity"
  | "date"
  | "number"
  | "boolean"
  | "presence";

export type FilterFieldConfig = {
  key: string;
  label?: string;
  type: "text" | "select" | "multiselect";
  /** The declared filter kind (`multiselect`, `idMulti`, `range`, …). */
  kind?: string;
  valueType?: FilterValueType;
  /** The entity an `entity` filter's values are records of. */
  referenceEntity?: string;
  /** The Filters panel section: the field's edit section, else by type. */
  group?: string;
  /** The type glyph override; an `entity` filter shows its entity's icon. */
  icon?: ReactNode;
  /** A range's lowest and highest value under the other filters (server facets). */
  bounds?: { min: string | null; max: string | null };
  options?: FilterOption[];
  placeholder?: string;
  inputType?: "text" | "number" | "date";
  min?: number;
  max?: number;
  description?: string;
  unsupportedReason?: string;
  /** Offers Match any | Match all (multi-valued fields only). */
  matchAll?: boolean;
  /** A multiselect with no roster: its values are typed, comma-separated. */
  freeText?: boolean;
  /** Fields sharing a group hold one value between them: picking replaces. */
  exclusiveGroup?: string;
  /** The "Include sub-…" toggle inside a hierarchical reference's editor. */
  subtree?: { label: string };
  /** Offers is | is not; a `reason` disables "is not" with that line. */
  exclude?: { reason: string | null };
  /** A date range: beside its presets the editor sets `from..to` bounds. */
  dateRange?: boolean;
  /** A number range: beside its presets the editor sets `min..max` bounds. */
  numberRange?: NumberRange;
  onActivate?: (selectedIds?: readonly string[]) => void;
  onSearchChange?: (query: string) => void;
  isLoading?: boolean;
  /** A roster of one entity's records: its pickers run in record mode. */
  records?: PickerRecordSource;
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
 * The two sides of a value filter: the values it includes ("is") and the
 * ones it excludes ("is not"), each with its own chip. One value list holds
 * both; excluded values carry {@link FILTER_NOT_PREFIX}.
 */
export type FilterSide = "is" | "isNot";

/** The sides of a filter's values that hold a value, in chip order. */
export function activeSides(
  values: readonly string[] | undefined,
): FilterSide[] {
  if (values === undefined) return [];
  const { included, excluded } = splitExcluded(values);
  return [
    ...(included.some((value) => value !== "" && !MODE_TOKENS.has(value))
      ? (["is"] as const)
      : []),
    ...(excluded.length > 0 ? (["isNot"] as const) : []),
  ];
}

/**
 * Every picked value on either side, unprefixed: the ids a deferred roster
 * loads so both sides' chips can name them.
 */
export const selectedValues = (values: readonly string[]): string[] => [
  ...sideValues(values, "is"),
  ...sideValues(values, "isNot"),
];

/** The values a side's picker shows: no mode tokens, excluded unprefixed. */
export function sideValues(
  values: readonly string[],
  side: FilterSide,
): string[] {
  const { included, excluded } = splitExcluded(values);
  return side === "is" ? pickerValues(included) : excluded;
}

/**
 * A picker change on one side, keeping the other side and the mode tokens.
 * The "is" side follows the Any value rule ({@link nextPickedValues}); the
 * "is not" side is a plain value list.
 */
export function withSideValues(
  previous: readonly string[],
  side: FilterSide,
  picked: readonly string[],
): string[] {
  const { included, excluded } = splitExcluded(previous);
  return side === "is"
    ? [
        ...nextPickedValues(included, picked),
        ...excluded.map((value) => `${FILTER_NOT_PREFIX}${value}`),
      ]
    : [...included, ...picked.map((value) => `${FILTER_NOT_PREFIX}${value}`)];
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
const pickerValues = (values: readonly string[]): string[] =>
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
 * rather than read off the source: a table takes the spec's declared `label`,
 * else the column header; a manifest-only bar takes the spec's label.
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
    kind: config.kind,
    valueType: config.valueType ?? valueTypeOf(type, config),
    referenceEntity: config.referenceEntity,
    group: config.group,
    icon: config.icon,
    placeholder: type === "text" ? `Filter ${label.toLowerCase()}…` : undefined,
    options: config.options
      ? config.options.map((option) => ({
          ...option,
          hint: optionHints?.[option.value] ?? option.hint,
        }))
      : undefined,
    matchAll: config.matchAll,
    freeText: config.freeText,
    exclusiveGroup: config.exclusiveGroup,
    subtree: config.subtree,
    exclude: config.exclude,
    dateRange: config.dateRange,
    numberRange: config.numberRange,
    onActivate: config.onActivate,
    onSearchChange: config.onSearchChange,
    isLoading: config.isLoading,
    records: config.records,
  };
}

/** A value type for a config that declares none (a hand-built column filter). */
const valueTypeOf = (
  type: FilterBarField["type"],
  config: FilterConfig,
): FilterValueType =>
  config.dateRange
    ? "date"
    : config.numberRange
      ? "number"
      : type === "text"
        ? "text"
        : config.records
          ? "entity"
          : "enum";
