import { X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import {
  FilterableCombobox,
  MultiFilterableCombobox,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import type { Filter, FilterBarField } from "./filter-bar-core";

/**
 * Cubby's small, manifest-backed filter bar.
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
  const fieldsByKey = useMemo(
    () => new Map(fields.map((field) => [field.key, field])),
    [fields],
  );
  const active = new Set(filters.map((filter) => filter.field));
  const available = fields.filter((field) => !active.has(field.key));

  const update = (id: string, values: string[]) =>
    onChange(
      filters.map((filter) =>
        filter.id === id ? { ...filter, values } : filter,
      ),
    );

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {filters.flatMap((filter) => {
        const field = fieldsByKey.get(filter.field);
        if (!field) return [];
        return (
          <div
            key={filter.id}
            className="flex h-7 min-w-0 items-center border border-border bg-muted/20 text-xs"
          >
            <span className="shrink-0 border-border border-r px-2 font-medium text-muted-foreground">
              {field.label}
            </span>
            {field.type === "text" ? (
              <Input
                value={filter.values[0] ?? ""}
                onChange={(event) => update(filter.id, [event.target.value])}
                placeholder={field.placeholder}
                className="h-full min-w-28 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
              />
            ) : field.type === "multiselect" ? (
              <MultiFilterableCombobox
                items={field.options ?? []}
                value={filter.values}
                onValueChange={(values) => update(filter.id, values)}
                placeholder={`Filter ${field.label ?? field.key}`}
                ariaLabel={`Filter ${field.label ?? field.key}`}
                className="min-w-28 border-0 bg-transparent shadow-none"
              />
            ) : (
              <FilterableCombobox
                items={field.options ?? []}
                value={filter.values[0] ?? null}
                onValueChange={(value) =>
                  update(filter.id, value === null ? [] : [value])
                }
                placeholder={`Filter ${field.label ?? field.key}`}
                ariaLabel={`Filter ${field.label ?? field.key}`}
                clearable
                className="min-w-28 border-0 bg-transparent shadow-none"
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={`Remove ${field.label ?? field.key} filter`}
              onClick={() =>
                onChange(filters.filter((item) => item.id !== filter.id))
              }
            >
              <X />
            </Button>
          </div>
        );
      })}
      {available.length > 0 && (
        <select
          aria-label="Add filter"
          className="h-7 min-w-0 border border-border bg-background px-2 text-xs"
          value=""
          onChange={(event) => {
            const key = event.target.value;
            const field = fieldsByKey.get(key);
            if (!field) return;
            onChange([
              ...filters,
              {
                id: `filter-${key}`,
                field: key,
                operator:
                  field.type === "text"
                    ? "contains"
                    : field.type === "multiselect"
                      ? "is_any_of"
                      : "is",
                values: [],
              },
            ]);
          }}
        >
          <option value="">+ Filter</option>
          {available.map((field) => (
            <option key={field.key} value={field.key}>
              {field.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
