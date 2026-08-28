import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { ListFilter, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  FilterableCombobox,
  MultiFilterableCombobox,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";

import type { Filter, FilterBarField } from "./filter-bar-core";

const EMPTY_FILTER_OPTIONS: NonNullable<FilterBarField["options"]> = [];
const INVALID_FILTER_OPTION = {
  value: UNRESOLVABLE_ENTITY_FILTER,
  label: "Invalid link filter",
  meta: true,
} as const;

function visibleOptions(field: FilterBarField, filter: Filter) {
  const options = field.options ?? EMPTY_FILTER_OPTIONS;
  return filter.values.includes(UNRESOLVABLE_ENTITY_FILTER) &&
    !options.some((option) => option.value === UNRESOLVABLE_ENTITY_FILTER)
    ? [INVALID_FILTER_OPTION, ...options]
    : options;
}

function filterSummary(field: FilterBarField, filter: Filter): string {
  if (filter.values.length === 0 || filter.values.every((value) => !value)) {
    return "Choose…";
  }
  if (field.type === "text") return filter.values[0] ?? "Choose…";
  const labels = new Map(
    visibleOptions(field, filter).map((option) => [option.value, option.label]),
  );
  return filter.values.map((value) => labels.get(value) ?? value).join(", ");
}

function FilterEditor({
  field,
  filter,
  update,
}: {
  field: FilterBarField;
  filter: Filter;
  update: (values: string[]) => void;
}) {
  const options = visibleOptions(field, filter);
  if (field.type === "text") {
    return (
      <Input
        autoFocus
        value={filter.values[0] ?? ""}
        onChange={(event) => update([event.target.value])}
        placeholder={field.placeholder}
        aria-label={`Filter ${field.label ?? field.key}`}
      />
    );
  }
  if (field.type === "multiselect") {
    return (
      <MultiFilterableCombobox
        items={options}
        value={filter.values}
        onValueChange={update}
        placeholder={`Filter ${field.label ?? field.key}`}
        ariaLabel={`Filter ${field.label ?? field.key}`}
        className="w-full"
        onOpenChange={(open) => {
          if (open) field.onActivate?.(filter.values);
        }}
        onSearchChange={field.onSearchChange}
        isLoading={field.isLoading}
      />
    );
  }
  return (
    <FilterableCombobox
      items={options}
      value={filter.values[0] ?? null}
      onValueChange={(value) => update(value === null ? [] : [value])}
      placeholder={`Filter ${field.label ?? field.key}`}
      ariaLabel={`Filter ${field.label ?? field.key}`}
      clearable
      className="w-full"
      onOpenChange={(open) => {
        if (open) field.onActivate?.(filter.values);
      }}
      onSearchChange={field.onSearchChange}
      isLoading={field.isLoading}
    />
  );
}

/**
 * Compact, manifest-backed expression of the table's active query.
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
}: {
  filters: Filter[];
  fields: FilterBarField[];
  onChange: (filters: Filter[]) => void;
  className?: string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const isMobile = useIsMobile();
  const fieldsByKey = useMemo(
    () => new Map(fields.map((field) => [field.key, field])),
    [fields],
  );
  const active = new Set(filters.map((filter) => filter.field));
  const available = fields.filter((field) => !active.has(field.key));

  useEffect(() => {
    for (const filter of filters) {
      fieldsByKey.get(filter.field)?.onActivate?.(filter.values);
    }
  }, [filters, fieldsByKey]);

  const update = (id: string, values: string[]) =>
    onChange(
      filters.map((filter) =>
        filter.id === id ? { ...filter, values } : filter,
      ),
    );

  const addField = (field: FilterBarField) => {
    field.onActivate?.();
    onChange([
      ...filters,
      {
        id: `filter-${field.key}`,
        field: field.key,
        operator:
          field.type === "text"
            ? "contains"
            : field.type === "multiselect"
              ? "is_any_of"
              : "is",
        values: [],
      },
    ]);
    setAddOpen(false);
  };

  const filterChoices = (
    <div className="grid gap-px border border-border bg-border">
      {available.map((field) => (
        <button
          key={field.key}
          type="button"
          className="min-h-10 bg-card px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none max-md:min-h-11"
          onClick={() => addField(field)}
        >
          {field.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain md:flex-wrap md:overflow-visible",
        className,
      )}
    >
      {filters.flatMap((filter) => {
        const field = fieldsByKey.get(filter.field);
        if (!field) return [];
        const label = field.label ?? field.key;
        const summary = filterSummary(field, filter);
        return (
          <div
            key={filter.id}
            className="group/filter flex h-7 max-w-72 shrink-0 items-stretch border border-border bg-card"
          >
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${label}: ${summary}`}
                    className="flex min-w-0 items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    title={`${label}: ${summary}`}
                  />
                }
              >
                <span className="border-r border-border px-2 font-mono text-2xs tracking-wide text-slate uppercase">
                  {label}
                </span>
                <span className="min-w-0 truncate px-2 text-xs">{summary}</span>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80">
                <PopoverTitle className="font-heading font-bold">
                  Filter by {label}
                </PopoverTitle>
                <FilterEditor
                  field={field}
                  filter={filter}
                  update={(values) => update(filter.id, values)}
                />
              </PopoverContent>
            </Popover>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-full shrink-0 border-l border-border"
              aria-label={`Remove ${label} filter`}
              onClick={() =>
                onChange(filters.filter((item) => item.id !== filter.id))
              }
            >
              <X />
            </Button>
          </div>
        );
      })}

      {available.length > 0 &&
        (isMobile ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => setAddOpen(true)}
          >
            <ListFilter />
            Filter
          </Button>
        ) : (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0"
                />
              }
            >
              <ListFilter />
              Filter
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <PopoverTitle className="font-heading font-bold">
                Add filter
              </PopoverTitle>
              {filterChoices}
            </PopoverContent>
          </Popover>
        ))}
      {filters.length > 1 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-muted-foreground"
          onClick={() => onChange([])}
        >
          Clear all
        </Button>
      )}

      {isMobile && (
        <ResponsiveSheet
          open={addOpen}
          onOpenChange={setAddOpen}
          title="Add filter"
          description="Choose another field to narrow this ledger."
        >
          {filterChoices}
        </ResponsiveSheet>
      )}
    </div>
  );
}
