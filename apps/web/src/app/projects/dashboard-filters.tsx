import { Badge } from "~/components/ui/badge";

export type Filters = {
  statuses: Set<string>;
  kinds: Set<string>;
  locations: Set<string>;
};

export const emptyFilters: Filters = {
  statuses: new Set(),
  kinds: new Set(),
  locations: new Set(),
};

function ToggleBadge({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}>
      <Badge
        variant={active ? "default" : "outline"}
        className="cursor-pointer"
      >
        {label}
      </Badge>
    </button>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-medium text-muted-foreground text-xs">
        {label}:
      </span>
      {options.map((option) => (
        <ToggleBadge
          key={option}
          label={option}
          active={selected.has(option)}
          onClick={() => onToggle(option)}
        />
      ))}
    </div>
  );
}

export function DashboardFilters({
  filters,
  onFiltersChange,
  availableStatuses,
  availableKinds,
  availableLocations,
}: {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  availableStatuses: string[];
  availableKinds: string[];
  availableLocations: string[];
}) {
  const hasFilters =
    filters.statuses.size > 0 ||
    filters.kinds.size > 0 ||
    filters.locations.size > 0;

  function toggle(key: keyof Filters, value: string) {
    const next = new Set(filters[key]);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onFiltersChange({ ...filters, [key]: next });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-4">
        <FilterGroup
          label="Status"
          options={availableStatuses}
          selected={filters.statuses}
          onToggle={(v) => toggle("statuses", v)}
        />
        <FilterGroup
          label="Kind"
          options={availableKinds}
          selected={filters.kinds}
          onToggle={(v) => toggle("kinds", v)}
        />
        <FilterGroup
          label="Location"
          options={availableLocations}
          selected={filters.locations}
          onToggle={(v) => toggle("locations", v)}
        />
      </div>
      {hasFilters && (
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={() => onFiltersChange(emptyFilters)}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
