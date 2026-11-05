import type { Entity } from "@cubby/schemas/entity";
import { humanize } from "@cubby/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { RowData } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { entityMetadata } from "~/entity/metadata";
import {
  type ListQueryState,
  useFilterFacets,
  useListQuery,
  useViewCounts,
  withFacets,
} from "~/entity/table/list-query-context";
import { Popover, PopoverContent } from "~/ui/primitives/popover";

import {
  FilterBar,
  type FilterResultCount,
  type FilterSheetSwitch,
  FiltersPanel,
  MobileFilterTier,
} from "../../ui/data-table/filter-bar";
import {
  barFieldFromConfig,
  type FilterBarField,
  filterStateToBarFilters,
} from "../../ui/data-table/filter-bar-core";
import type { CubbyTable as Table } from "../../ui/data-table/table-features";
import { useColumnFilterEditRequests } from "../../ui/data-table/table-meta";
import { useFilterBarDraft } from "../../ui/data-table/use-filter-bar-draft";

function isColumnLabel(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * The table-backed manifest filter bar: fields come from the mounted columns'
 * `meta.filterConfig` plus the table's `meta.filterFields` (declared filters
 * no column hosts), state from TanStack. Everything else lives in
 * `filter-bar-core` / `useFilterBarDraft`, shared with the URL-backed bar.
 */
function getLedgerFields<TData extends RowData>(
  table: Table<TData>,
  optionHints?: Readonly<Record<string, Readonly<Record<string, string>>>>,
  primarySearch?: { key: string; placeholder: string } | null,
): FilterBarField[] {
  const columnFields = table.getAllLeafColumns().flatMap((column) => {
    const config = column.columnDef.meta?.filterConfig;
    if (!config) return [];
    const header = column.columnDef.header;
    const label =
      config.label ?? (isColumnLabel(header) ? header : humanize(column.id));
    let hints = optionHints?.[column.id];
    if (!hints && config.facetCount && table.options.meta?.completeLocalData) {
      // Only complete bounded lists may count locally. A server page is not
      // evidence for the full result set's facet counts.
      const counts = new Map<unknown, number>();
      for (const row of table.getCoreRowModel().rows) {
        const value = row.getValue<unknown>(column.id);
        for (const item of Array.isArray(value) ? value : [value]) {
          counts.set(item, (counts.get(item) ?? 0) + 1);
        }
      }
      hints = Object.fromEntries(
        (config.options ?? []).map((option) => [
          option.value,
          String(counts.get(option.value) ?? 0),
        ]),
      );
    }
    return [barFieldFromConfig(column.id, label, config, hints)];
  });
  const fields = [...columnFields, ...(table.options.meta?.filterFields ?? [])];
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

type OptionHints = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * One table's manifest filter state for whichever editor owns it: declared
 * fields with facets for the open editor and active filters, and the live
 * draft committed to the table's column filters.
 */
function useLedgerFilterState<TData extends RowData>({
  table,
  entity,
  optionHints,
  query,
}: {
  table: Table<TData>;
  entity: Entity | undefined;
  optionHints: OptionHints | undefined;
  query: ListQueryState | null;
}) {
  // TanStack v9 materializes leaf columns after the first table render.
  const queryClient = useQueryClient();
  // table/options references stay stable across that boundary, so they cannot
  // by themselves invalidate this memo; include the resolved filter-column
  // signature so an initially empty query strip hydrates as soon as the
  // manifest-bearing leaf columns exist.
  const filterColumnsKey = table
    .getAllLeafColumns()
    .filter((column) => column.columnDef.meta?.filterConfig)
    .map((column) => column.id)
    .join("|");
  const primarySearch =
    table.options.meta?.primarySearch ??
    (entity ? entityMetadata(queryClient, entity).summary.primarySearch : null);
  const declaredFields = useMemo(
    () => getLedgerFields(table, optionHints, primarySearch),
    // oxlint-disable-next-line react/exhaustive-deps -- filterColumnsKey is the late-materializing TanStack v9 signal described above
    [
      table,
      table.options.columns,
      table.options.data,
      table.options.meta?.filterFields,
      optionHints,
      filterColumnsKey,
      primarySearch,
    ],
  );
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  const externalColumnFilters = table.state.columnFilters;
  const facets = useFilterFacets(query, [
    ...(openEditor ? [openEditor] : []),
    ...externalColumnFilters.map((filter) => filter.id),
  ]);
  const fields = useMemo(
    () => withFacets(declaredFields, facets),
    [declaredFields, facets],
  );
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
  return {
    fields,
    draftFilters,
    handleChange,
    primarySearch,
    setOpenEditor,
  };
}

function localResultCount<TData extends RowData>(
  table: Table<TData>,
  query: ListQueryState | null,
  total: number | undefined,
  noun: string | undefined,
): FilterResultCount {
  const local = table.options.meta?.completeLocalData;
  return {
    matching:
      query?.matching ??
      (local ? table.getFilteredRowModel().rows.length : undefined),
    total: total ?? (local ? table.getCoreRowModel().rows.length : undefined),
    noun,
  };
}

function pluralLowerOf(entity: Entity | undefined) {
  return entity && isBrowserRoutedEntity(entity)
    ? entities[entity].pluralLabel.toLowerCase()
    : undefined;
}

export function LedgerFilters<TData extends RowData>({
  table,
  entity,
  optionHints,
  variant = "desktop",
  switches,
  workbench = false,
}: {
  table: Table<TData>;
  /** Drives the search placeholder ("Search products"); omitted tables get no plural. */
  entity?: Entity;
  /** Server facet counts by mounted column id then option value. */
  optionHints?: OptionHints;
  /**
   * `mobile` renders the phone band's tier (search + `Filter` sheet with a
   * count badge, active-chip strip) instead of the desktop chip row — same
   * fields, same draft state, different presentation.
   */
  variant?: "desktop" | "mobile";
  /**
   * A page workbench: active chips render into the page list's strip above
   * the records, with its facet counts and filtered total; elsewhere they
   * follow the Filter button in place.
   */
  workbench?: boolean;
  /** Phone only: the presentation switches, which live in the Filter sheet. */
  switches?: readonly FilterSheetSwitch[] | undefined;
}) {
  // This bar owns the table's filter editors: a column header's Filter…
  // opens the panel on that column's field.
  const [editRequest, setEditRequest] = useState<{ key: string } | null>(null);
  const requestEdit = useCallback(
    (columnId: string) => setEditRequest({ key: columnId }),
    [],
  );
  useColumnFilterEditRequests(table, requestEdit);
  const query = useListQuery(workbench ? entity : undefined);
  const { fields, draftFilters, handleChange, primarySearch, setOpenEditor } =
    useLedgerFilterState({ table, entity, optionHints, query });
  const [countsRequested, setCountsRequested] = useState(false);
  const { total } = useViewCounts(query?.entity, countsRequested);
  const openEditor = useCallback(
    (key: string | null) => {
      if (key !== null) setCountsRequested(true);
      setOpenEditor(key);
    },
    [setOpenEditor],
  );

  const pluralLower = pluralLowerOf(entity);
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
        switches={switches}
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
      chipsTarget={query ? query.chipsTarget : undefined}
      onEditorChange={openEditor}
      editRequest={editRequest}
      resultCount={localResultCount(table, query, total, pluralLower)}
    />
  );
}

/**
 * The filter editor of a table without a toolbar: a column header's Filter…
 * opens the shared focused panel beside that header. Filters stay in the
 * table's own state; the page renders no chips for them.
 */
export function HeaderFilterEditor<TData extends RowData>({
  table,
  entity,
  optionHints,
}: {
  table: Table<TData>;
  entity?: Entity;
  optionHints?: OptionHints;
}) {
  const [request, setRequest] = useState<{
    key: string;
    anchor: Element | null;
    seq: number;
  } | null>(null);
  const requestEdit = useCallback(
    (columnId: string, anchor?: Element | null) =>
      setRequest((old) => ({
        key: columnId,
        anchor: anchor ?? null,
        seq: (old?.seq ?? 0) + 1,
      })),
    [],
  );
  useColumnFilterEditRequests(table, requestEdit);
  const query = useListQuery(entity);
  const { fields, draftFilters, handleChange, primarySearch, setOpenEditor } =
    useLedgerFilterState({ table, entity, optionHints, query });
  return (
    <Popover
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
    >
      <PopoverContent
        anchor={request?.anchor}
        align="start"
        className="w-[28rem] p-0"
      >
        {request ? (
          <FiltersPanel
            key={request.seq}
            filters={draftFilters}
            fields={fields}
            onChange={handleChange}
            searchKey={primarySearch?.key}
            initialKey={request.key}
            onEditorChange={setOpenEditor}
            resultCount={localResultCount(
              table,
              query,
              undefined,
              pluralLowerOf(entity),
            )}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
