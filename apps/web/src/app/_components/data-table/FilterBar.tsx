import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import type { RowData } from "@tanstack/react-table";
import {
  Check as CheckIcon,
  ChevronDown,
  ListFilter,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { cn } from "~/lib/utils";

import {
  type Filter,
  type FilterBarField,
  hasFilterValue,
  operatorFor,
} from "./filter-bar-core";
import { sortableColumns, SortSection } from "./MobileSortSheet";
import type { CubbyTable as Table } from "./table-features";
import TableLayoutCustomizer from "./TableLayoutCustomizer";

const EMPTY_FILTER_OPTIONS: NonNullable<FilterBarField["options"]> = [];
const INVALID_FILTER_OPTION: NonNullable<FilterBarField["options"]>[number] = {
  value: UNRESOLVABLE_ENTITY_FILTER,
  label: "Invalid link filter",
  meta: true,
};

/** Chips shown before the rest collapse behind the ghost `More` control. */
// Three declared chips plus the search input fit in one band beside the
// 208px domain rail at 1440; a fourth wraps `More` onto a second line.
const CHIP_CAP = 3;

/** A declared field is "active" (tints its chip, counts toward Clear N) once its filter has a real value. */
function isFieldActive(filter: Filter | undefined): boolean {
  return filter !== undefined && hasFilterValue(filter);
}

function visibleOptions(field: FilterBarField, filter: Filter | undefined) {
  const options = field.options ?? EMPTY_FILTER_OPTIONS;
  return filter?.values.includes(UNRESOLVABLE_ENTITY_FILTER) &&
    !options.some((option) => option.value === UNRESOLVABLE_ENTITY_FILTER)
    ? [INVALID_FILTER_OPTION, ...options]
    : options;
}

/** The chip's value text — "any" is the declared-but-inactive state, per DESIGN.md. */
function filterSummary(
  field: FilterBarField,
  filter: Filter | undefined,
): string {
  if (filter === undefined || !isFieldActive(filter)) return "any";
  if (field.type === "text") return filter.values[0] ?? "any";
  const labels = new Map(
    visibleOptions(field, filter).map((option) => [option.value, option.label]),
  );
  return filter.values.map((value) => labels.get(value) ?? value).join(", ");
}

/** Multiselect editor: searchable checklist with facet hints, Clear/Apply footer. */
function MultiselectEditor({
  field,
  filter,
  onApply,
  onClear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  onApply: (values: string[]) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(filter?.values ?? []),
  );
  const options = visibleOptions(field, filter);
  useEffect(() => {
    field.onActivate?.(filter?.values ?? []);
  }, [field, filter?.values]);
  useEffect(() => {
    field.onSearchChange?.(query);
  }, [field, query]);
  const filtered = query
    ? options.filter((option) =>
        option.label.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={focusOnMount}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Filter ${field.label ?? field.key}`}
        aria-label={`Filter ${field.label ?? field.key}`}
        className="h-8"
      />
      <div className="max-h-64 overflow-y-auto">
        {filtered.map((option) => {
          const checked = draft.has(option.value);
          const toggle = () =>
            setDraft((previous) => {
              const nextSet = new Set(previous);
              if (nextSet.has(option.value)) nextSet.delete(option.value);
              else nextSet.add(option.value);
              return nextSet;
            });
          return (
            // Not a `<label>`: wrapping a checkbox control in one makes it
            // derive its accessible name from that label's content, which —
            // since the label also CONTAINS the checkbox — is a
            // self-referential aria-labelledby loop that
            // dom-accessibility-api resolves to an empty name. A real button
            // keeps the row keyboard-operable, with its own text as the
            // accessible label; the checked-state glyph is a plain `aria-hidden`
            // icon rather than an interactive `Checkbox`, so there's no nested
            // control competing for the click.
            <button
              key={option.value}
              type="button"
              className="flex min-h-8 w-full items-center gap-2 rounded-sm px-1 text-left text-xs hover:bg-muted"
              onClick={toggle}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors duration-150",
                  checked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-checkbox-border bg-card",
                )}
              >
                {checked && <CheckIcon className="size-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint && (
                <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                  {option.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onClear}
        >
          Clear
        </Button>
        <Button type="button" size="sm" onClick={() => onApply([...draft])}>
          Apply
        </Button>
      </div>
    </div>
  );
}

/** The editor body for one field's popover — shape depends on its declared type. */
function FilterEditor({
  field,
  filter,
  setValues,
  clear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  setValues: (values: string[]) => void;
  clear: () => void;
}) {
  const options = visibleOptions(field, filter);
  if (field.type === "text") {
    return (
      <Input
        ref={focusOnMount}
        value={filter?.values[0] ?? ""}
        onChange={(event) => setValues([event.target.value])}
        placeholder={field.placeholder}
        aria-label={`Filter ${field.label ?? field.key}`}
      />
    );
  }
  if (field.type === "multiselect") {
    return (
      <MultiselectEditor
        field={field}
        filter={filter}
        onApply={setValues}
        onClear={clear}
      />
    );
  }
  return (
    <FilterableCombobox
      items={options}
      value={filter?.values[0] ?? null}
      onValueChange={(value) => setValues(value === null ? [] : [value])}
      placeholder={`Filter ${field.label ?? field.key}`}
      ariaLabel={`Filter ${field.label ?? field.key}`}
      clearable
      className="w-full"
      onOpenChange={(open) => {
        if (open) field.onActivate?.(filter?.values ?? []);
      }}
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
    />
  );
}

/** One declared-filter chip: `<b>Label</b> value|any`, opens its editor on click. */
function FilterChip({
  field,
  filter,
  open,
  onOpenChange,
  setValues,
  clear,
}: {
  field: FilterBarField;
  filter: Filter | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setValues: (values: string[]) => void;
  clear: () => void;
}) {
  const label = field.label ?? field.key;
  const summary = filterSummary(field, filter);
  const active = isFieldActive(filter);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${summary}`}
            title={`${label}: ${summary}`}
            className={cn(
              "flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary",
              active && "border-primary bg-primary/8",
            )}
          />
        }
      >
        <b className="font-medium">{label}</b>
        <span className="min-w-0 truncate text-muted-foreground">
          {summary}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <PopoverTitle className="font-heading font-bold">
          Filter by {label}
        </PopoverTitle>
        <FilterEditor
          field={field}
          filter={filter}
          setValues={setValues}
          clear={clear}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Compact, manifest-backed expression of the table's active query: a search
 * input for the entity's title field, one chip per every other declared
 * field (capped, with the rest behind `More`), and a `Clear N` link.
 *
 * This intentionally supports only the three filter shapes emitted by
 * `barFieldFromConfig`. The old copy-owned ReUI component advertised async
 * loaders, custom renderers, nested groups, arbitrary operators and shortcut
 * handling, none of which Cubby's two production filter bars supplied.
 */
export function FilterBar({
  filters,
  fields,
  onChange,
  className,
  searchKey,
  searchPlaceholder,
}: {
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  className?: string;
  /** The field rendered as a search input instead of a chip (the entity's title field). */
  searchKey?: string;
  searchPlaceholder?: string;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const filtersByField = useMemo(
    () => new Map(filters.map((filter) => [filter.field, filter])),
    [filters],
  );
  useEffect(() => {
    for (const field of fields) {
      const filter = filtersByField.get(field.key);
      if (filter && isFieldActive(filter)) field.onActivate?.(filter.values);
    }
  }, [fields, filtersByField]);
  const searchField = fields.find((field) => field.key === searchKey);
  const chipFields = fields.filter((field) => field.key !== searchKey);
  const visibleChipFields = chipFields.slice(0, CHIP_CAP);
  const overflowChipFields = chipFields.slice(CHIP_CAP);
  const activeCount = filters.filter(hasFilterValue).length;

  const setValues = (field: FilterBarField, values: string[]) => {
    const existing = filtersByField.get(field.key);
    if (existing) {
      onChange(
        filters.map((filter) =>
          filter.field === field.key ? { ...filter, values } : filter,
        ),
      );
    } else {
      field.onActivate?.();
      onChange([
        ...filters,
        {
          id: `filter-${field.key}`,
          field: field.key,
          operator: operatorFor(field),
          values,
        },
      ]);
    }
  };
  const clear = (field: FilterBarField) =>
    onChange(filters.filter((filter) => filter.field !== field.key));

  const searchFilter = searchField
    ? filtersByField.get(searchField.key)
    : undefined;
  const searchValue = searchFilter?.values[0] ?? "";

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain md:flex-wrap md:overflow-visible",
        className,
      )}
    >
      {searchField && (
        <div className="relative flex h-7 w-[220px] shrink-0 items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input
            value={searchValue}
            onChange={(event) => setValues(searchField, [event.target.value])}
            placeholder={
              searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
            }
            aria-label={
              searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
            }
            className="h-7 pr-6 pl-7 text-xs"
          />
          {searchValue && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => clear(searchField)}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {visibleChipFields.map((field) => (
        <FilterChip
          key={field.key}
          field={field}
          filter={filtersByField.get(field.key)}
          open={editingKey === field.key}
          onOpenChange={(open) => setEditingKey(open ? field.key : null)}
          setValues={(values) => {
            setValues(field, values);
            // Apply commits and closes; a text/combobox editor commits per
            // keystroke and stays open until dismissed.
            if (field.type === "multiselect") setEditingKey(null);
          }}
          clear={() => {
            clear(field);
            setEditingKey(null);
          }}
        />
      ))}

      {overflowChipFields.length > 0 &&
        (() => {
          const editingOverflow = overflowChipFields.find(
            (field) => field.key === editingKey,
          );
          return (
            <Popover
              open={moreOpen}
              onOpenChange={(open) => {
                setMoreOpen(open);
                if (!open) setEditingKey(null);
              }}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0"
                  />
                }
              >
                <ChevronDown className="size-3.5" />
                More
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72">
                {editingOverflow ? (
                  <>
                    <PopoverTitle className="font-heading font-bold">
                      Filter by {editingOverflow.label ?? editingOverflow.key}
                    </PopoverTitle>
                    <FilterEditor
                      field={editingOverflow}
                      filter={filtersByField.get(editingOverflow.key)}
                      setValues={(values) => setValues(editingOverflow, values)}
                      clear={() => {
                        clear(editingOverflow);
                        setEditingKey(null);
                      }}
                    />
                  </>
                ) : (
                  <>
                    <PopoverTitle className="font-heading font-bold">
                      More filters
                    </PopoverTitle>
                    <div className="flex flex-col gap-px">
                      {overflowChipFields.map((field) => {
                        const filter = filtersByField.get(field.key);
                        const label = field.label ?? field.key;
                        const summary = filterSummary(field, filter);
                        return (
                          <button
                            key={field.key}
                            type="button"
                            aria-label={`${label}: ${summary}`}
                            className="flex min-h-9 items-center justify-between gap-2 rounded-sm px-2 text-left text-xs hover:bg-muted"
                            onClick={() => setEditingKey(field.key)}
                          >
                            <b className="font-medium">{label}</b>
                            <span className="min-w-0 truncate text-muted-foreground">
                              {summary}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </PopoverContent>
            </Popover>
          );
        })()}

      {activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-primary"
          onClick={() => onChange([])}
        >
          Clear {activeCount}
        </Button>
      )}
    </div>
  );
}

/**
 * The phone workbench band's query tier: search + a `Filter` button carrying
 * a count badge, then a horizontal strip of only the ACTIVE chips (declared
 * but inactive fields stay inside the sheet — there's no room for an "any"
 * chip row on a 375px band). `Filter` opens one sheet listing every declared
 * field (tap drills into its editor), a `Sort` section, and `Columns` last.
 */
export function MobileFilterTier<TData extends RowData>({
  table,
  filters,
  fields,
  onChange,
  searchKey,
  searchPlaceholder,
}: {
  table: Table<TData>;
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  searchKey?: string;
  searchPlaceholder?: string;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [view, setView] = useState<"fields" | "columns" | string>("fields");
  const filtersByField = useMemo(
    () => new Map(filters.map((filter) => [filter.field, filter])),
    [filters],
  );
  const searchField = fields.find((field) => field.key === searchKey);
  const chipFields = fields.filter((field) => field.key !== searchKey);
  const activeChipFields = chipFields.filter((field) =>
    isFieldActive(filtersByField.get(field.key)),
  );
  const activeCount = filters.filter(hasFilterValue).length;
  const editingField = chipFields.find((field) => field.key === view);
  // The `Filter` sheet is also where phone sort lives — surface the trigger
  // for a sortable-only table even when it declares no filterable fields.
  const hasSort = sortableColumns(table).length > 0;
  const showFilterTrigger = chipFields.length > 0 || hasSort;

  const setValues = (field: FilterBarField, values: string[]) => {
    const existing = filtersByField.get(field.key);
    if (existing) {
      onChange(
        filters.map((filter) =>
          filter.field === field.key ? { ...filter, values } : filter,
        ),
      );
    } else {
      field.onActivate?.();
      onChange([
        ...filters,
        {
          id: `filter-${field.key}`,
          field: field.key,
          operator: operatorFor(field),
          values,
        },
      ]);
    }
  };
  const clear = (field: FilterBarField) =>
    onChange(filters.filter((filter) => filter.field !== field.key));

  const searchFilter = searchField
    ? filtersByField.get(searchField.key)
    : undefined;
  const searchValue = searchFilter?.values[0] ?? "";

  const openSheet = (nextView: typeof view) => {
    setView(nextView);
    setSheetOpen(true);
  };

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex w-full items-center gap-2">
        {searchField && (
          <div className="relative flex h-9 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
            <Input
              value={searchValue}
              onChange={(event) => setValues(searchField, [event.target.value])}
              placeholder={
                searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
              }
              aria-label={
                searchPlaceholder ?? `Search ${searchField.label ?? "records"}`
              }
              className="h-9 pr-3 pl-8"
            />
          </div>
        )}
        {showFilterTrigger && (
          <Button
            type="button"
            variant="outline"
            className="relative h-9 shrink-0"
            onClick={() => openSheet("fields")}
          >
            <ListFilter />
            Filter
            {activeCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex size-[18px] items-center justify-center rounded-full bg-primary font-mono text-2xs font-semibold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        )}
      </div>

      {activeChipFields.length > 0 && (
        <div className="flex w-full basis-full [scrollbar-width:none] gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {activeChipFields.map((field) => {
            const filter = filtersByField.get(field.key);
            const label = field.label ?? field.key;
            return (
              <span
                key={field.key}
                className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-primary bg-primary/8 px-2 text-2xs whitespace-nowrap"
              >
                <button
                  type="button"
                  onClick={() => openSheet(field.key)}
                  className="flex items-center gap-1"
                >
                  <b className="font-medium">{label}</b>
                  {filterSummary(field, filter)}
                </button>
                <button
                  type="button"
                  aria-label={`Clear ${label} filter`}
                  onClick={() => clear(field)}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <ResponsiveSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={
          editingField
            ? `Filter by ${editingField.label ?? editingField.key}`
            : view === "columns"
              ? "Columns"
              : "Filter"
        }
      >
        {editingField ? (
          <FilterEditor
            field={editingField}
            filter={filtersByField.get(editingField.key)}
            setValues={(values) => {
              setValues(editingField, values);
            }}
            clear={() => {
              clear(editingField);
              setView("fields");
            }}
          />
        ) : view === "columns" ? (
          <TableLayoutCustomizer table={table} />
        ) : (
          <div className="flex flex-col">
            {chipFields.map((field) => {
              const filter = filtersByField.get(field.key);
              return (
                <button
                  key={field.key}
                  type="button"
                  className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-1 text-left text-sm"
                  onClick={() => setView(field.key)}
                >
                  <span className="font-medium">
                    {field.label ?? field.key}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {filterSummary(field, filter)}
                  </span>
                </button>
              );
            })}
            <SortSection table={table} />
            <button
              type="button"
              className="mt-2 flex min-h-11 items-center gap-2 border-t border-border pt-2 text-left text-sm font-medium"
              onClick={() => setView("columns")}
            >
              <Settings2 className="size-4" />
              Columns
            </button>
          </div>
        )}
      </ResponsiveSheet>
    </div>
  );
}
