import { useDebouncedValue } from "@tanstack/react-pacer";
import type { ColumnFiltersState, Table } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Filter,
  type FilterFieldConfig,
  Filters,
} from "~/components/reui/filters";
import type { FilterConfig } from "./columnHelpers";

type LedgerFilterField = FilterFieldConfig<string> & {
  key: string;
  type: "text" | "select" | "multiselect";
};

const TEXT_OPERATORS = [{ value: "contains", label: "contains" }];
const SELECT_OPERATORS = [{ value: "is", label: "is" }];
const MULTISELECT_OPERATORS = [{ value: "is_any_of", label: "is any of" }];

const humanize = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());

function operatorFor(field: LedgerFilterField): string {
  if (field.type === "text") return "contains";
  if (field.type === "multiselect") return "is_any_of";
  return "is";
}

export function columnFiltersToLedgerFilters(
  columnFilters: ColumnFiltersState,
  fields: LedgerFilterField[],
): Filter<string>[] {
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

export function ledgerFiltersToColumnFilters(
  filters: Filter<string>[],
  fields: LedgerFilterField[],
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

const filterStateKey = (filters: Filter<string>[]): string =>
  JSON.stringify(
    filters
      .map(({ field, operator, values }) => ({ field, operator, values }))
      .sort((left, right) => left.field.localeCompare(right.field)),
  );

function getLedgerFields<TData>(table: Table<TData>): LedgerFilterField[] {
  return table.getAllLeafColumns().flatMap((column) => {
    const config = column.columnDef.meta?.filterConfig as
      | FilterConfig
      | undefined;
    if (!config) return [];

    const type = config.filterType ?? "text";
    const header = column.columnDef.header;
    const label = typeof header === "string" ? header : humanize(column.id);
    const operators =
      type === "text"
        ? TEXT_OPERATORS
        : type === "multiselect"
          ? MULTISELECT_OPERATORS
          : SELECT_OPERATORS;

    return [
      {
        key: column.id,
        label,
        type,
        operators,
        defaultOperator: operators[0]!.value,
        placeholder:
          type === "text" ? `Filter ${label.toLowerCase()}…` : undefined,
        searchable: type !== "text",
        options: config.options?.map((option) => ({
          value: option.value,
          label: option.label,
          icon: option.icon,
        })),
      },
    ];
  });
}

export function LedgerFilters<TData>({ table }: { table: Table<TData> }) {
  const fields = useMemo(
    () => getLedgerFields(table),
    [table, table.options.columns],
  );
  const externalColumnFilters = table.getState().columnFilters;
  const externalFilters = useMemo(
    () => columnFiltersToLedgerFilters(externalColumnFilters, fields),
    [externalColumnFilters, fields],
  );
  const [draftFilters, setDraftFilters] =
    useState<Filter<string>[]>(externalFilters);
  const [debouncedDraftFilters] = useDebouncedValue(draftFilters, {
    wait: 500,
  });
  const lastExternalKeyRef = useRef(filterStateKey(externalFilters));

  const externalKey = filterStateKey(externalFilters);
  const draftKey = filterStateKey(draftFilters);
  const debouncedDraftKey = filterStateKey(debouncedDraftFilters);
  if (externalKey !== lastExternalKeyRef.current) {
    lastExternalKeyRef.current = externalKey;
    if (externalKey !== draftKey) {
      setDraftFilters(externalFilters);
    }
  }

  useEffect(() => {
    // Header filters, saved views, reset, and URL restoration can advance the
    // table while this hook's debounced value still represents its previous
    // draft. Only a debounce that has caught up to the latest local draft may
    // write back; otherwise it would immediately undo the external change.
    if (debouncedDraftKey !== draftKey) return;

    // ReUI creates text filters with an empty value so their focused input can
    // exist before the user types. That placeholder is real draft UI state but
    // intentionally normalizes to no TanStack filter. Compare the normalized
    // state to the table so an empty input stays mounted instead of being
    // written as `[]` and then removed by the external-state sync.
    const nextColumnFilters = ledgerFiltersToColumnFilters(
      debouncedDraftFilters,
      fields,
    );
    const nextExternalKey = filterStateKey(
      columnFiltersToLedgerFilters(nextColumnFilters, fields),
    );
    if (nextExternalKey === externalKey) return;

    lastExternalKeyRef.current = nextExternalKey;
    table.setColumnFilters(nextColumnFilters);
  }, [
    debouncedDraftFilters,
    debouncedDraftKey,
    draftKey,
    externalKey,
    fields,
    table,
  ]);

  const handleChange = (nextFilters: Filter<string>[]) => {
    const previousByField = new Map(
      draftFilters.map((filter) => [filter.field, filter]),
    );
    const nextByField = new Map(
      nextFilters.map((filter) => [filter.field, filter]),
    );
    const changedFields = new Set([
      ...previousByField.keys(),
      ...nextByField.keys(),
    ]);
    const commitImmediately = [...changedFields].some((fieldKey) => {
      const previous = previousByField.get(fieldKey);
      const next = nextByField.get(fieldKey);
      if (
        JSON.stringify(previous?.values) === JSON.stringify(next?.values) &&
        previous?.operator === next?.operator
      ) {
        return false;
      }
      const field = fields.find((candidate) => candidate.key === fieldKey);
      return !next || field?.type !== "text";
    });

    setDraftFilters(nextFilters);
    if (commitImmediately) {
      lastExternalKeyRef.current = filterStateKey(nextFilters);
      table.setColumnFilters(ledgerFiltersToColumnFilters(nextFilters, fields));
    }
  };

  if (fields.length === 0) return null;

  return (
    <Filters
      filters={draftFilters}
      fields={fields}
      onChange={handleChange}
      allowMultiple={false}
      collapseAddButton
      showSearchInput
      size="sm"
      variant="solid"
      className="min-w-0"
    />
  );
}
