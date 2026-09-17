import type { Entity } from "@cubby/schemas/entity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import type { RowData } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { humanize } from "~/entities/filters";

import {
  barFieldFromConfig,
  type FilterBarField,
  filterStateToBarFilters,
} from "./filter-bar-core";
import { FilterBar, MobileFilterTier } from "./FilterBar";
import type { CubbyTable as Table } from "./table-features";
import { useFilterBarDraft } from "./useFilterBarDraft";

function isColumnLabel(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * The table-backed manifest filter bar: fields come from the mounted columns'
 * `meta.filterConfig`, state from TanStack. Everything else lives in
 * `filter-bar-core` / `useFilterBarDraft`, shared with the URL-backed bar.
 */
function getLedgerFields<TData extends RowData>(
  table: Table<TData>,
  optionHints?: Readonly<Record<string, Readonly<Record<string, string>>>>,
  primarySearch?: { key: string; placeholder: string } | null,
): FilterBarField[] {
  const fields = table.getAllLeafColumns().flatMap((column) => {
    const config = column.columnDef.meta?.filterConfig;
    if (!config) return [];
    const header = column.columnDef.header;
    const label = isColumnLabel(header) ? header : humanize(column.id);
    return [
      barFieldFromConfig(column.id, label, config, optionHints?.[column.id]),
    ];
  });
  return primarySearch
    ? [
        {
          key: primarySearch.key,
          label: "Search",
          type: "text",
          placeholder: primarySearch.placeholder,
        },
        ...fields.filter((field) => field.key !== primarySearch.key),
      ]
    : fields;
}

export function LedgerFilters<TData extends RowData>({
  table,
  entity,
  optionHints,
  variant = "desktop",
}: {
  table: Table<TData>;
  /** Drives the search placeholder ("Search products"); omitted tables get no plural. */
  entity?: Entity;
  /** Server facet counts by mounted column id then option value. */
  optionHints?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * `mobile` renders the phone band's tier (search + `Filter` sheet with a
   * count badge, active-chip strip) instead of the desktop chip row — same
   * fields, same draft state, different presentation.
   */
  variant?: "desktop" | "mobile";
}) {
  // TanStack v9 materializes leaf columns after the first table render. The
  // table/options references stay stable across that boundary, so they cannot
  // by themselves invalidate this memo; include the resolved filter-column
  // signature so an initially empty query strip hydrates as soon as the
  // manifest-bearing leaf columns exist.
  const filterColumnsKey = table
    .getAllLeafColumns()
    .filter((column) => column.columnDef.meta?.filterConfig)
    .map((column) => column.id)
    .join("|");
  const primarySearch = entity
    ? entityInspectorMetadata[entity].primarySearch
    : null;
  const fields = useMemo(
    () => getLedgerFields(table, optionHints, primarySearch),
    // oxlint-disable-next-line react/exhaustive-deps -- filterColumnsKey is the late-materializing TanStack v9 signal described above
    [
      table,
      table.options.columns,
      optionHints,
      filterColumnsKey,
      primarySearch,
    ],
  );
  const externalColumnFilters = table.state.columnFilters;
  const externalFilters = useMemo(
    () => filterStateToBarFilters(externalColumnFilters, fields),
    [externalColumnFilters, fields],
  );
  const commit = useCallback(
    (next: Parameters<typeof table.setColumnFilters>[0]) =>
      table.setColumnFilters(next),
    [table],
  );
  const { draftFilters, handleChange } = useFilterBarDraft({
    externalFilters,
    fields,
    commit,
  });

  const pluralLower =
    entity && isBrowserRoutedEntity(entity)
      ? entities[entity].pluralLabel.toLowerCase()
      : undefined;
  const searchPlaceholder =
    primarySearch?.placeholder ??
    (pluralLower ? `Search ${pluralLower}` : undefined);

  // Sort lives inside the phone `Filter` sheet regardless of whether this
  // table declares any filterable fields — a sortable-only table must not
  // lose its only phone sort affordance just because it has no filters.
  if (variant === "mobile") {
    return (
      <MobileFilterTier
        table={table}
        filters={draftFilters}
        fields={fields}
        onChange={handleChange}
        searchKey={primarySearch?.key}
        searchPlaceholder={searchPlaceholder}
      />
    );
  }

  if (fields.length === 0) return null;

  return (
    <FilterBar
      filters={draftFilters}
      fields={fields}
      onChange={handleChange}
      className="min-w-0"
      searchKey={primarySearch?.key}
      searchPlaceholder={searchPlaceholder}
    />
  );
}
