import type { ProjectStatus } from "@cubby/schemas/project";
import { format, startOfYear, subMonths } from "date-fns";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { capitalize, PROJECT_STATUS_LABELS } from "./shared";

export type Filters = {
  statuses: Set<string>;
  kinds: Set<string>;
  locations: Set<string>;
  /** Preset key ("3m" | "12m" | "ytd") or a 4-digit year; null = all time. */
  dateRange: string | null;
};

export const emptyFilters: Filters = {
  statuses: new Set(),
  kinds: new Set(),
  locations: new Set(),
  dateRange: null,
};

export type DateRangeBounds = {
  /** Inclusive `YYYY-MM-DD` bounds — compare plain-date strings lexicographically. */
  from: string;
  to: string;
};

const DATE_RANGE_PRESETS = [
  { key: "3m", label: "Last 3 months" },
  { key: "12m", label: "Last 12 months" },
  { key: "ytd", label: "This year" },
] as const;

/** Resolve a dateRange filter key to inclusive plain-date bounds. */
export function dateRangeBounds(
  key: string,
  today = new Date(),
): DateRangeBounds | null {
  const iso = (d: Date) => format(d, "yyyy-MM-dd");
  switch (key) {
    case "3m":
      return { from: iso(subMonths(today, 3)), to: iso(today) };
    case "12m":
      return { from: iso(subMonths(today, 12)), to: iso(today) };
    case "ytd":
      return { from: iso(startOfYear(today)), to: iso(today) };
    default:
      return /^\d{4}$/.test(key)
        ? { from: `${key}-01-01`, to: `${key}-12-31` }
        : null;
  }
}

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
  formatLabel = (v) => v,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  /** Human-facing label for a raw option value — defaults to identity. */
  formatLabel?: (value: string) => string;
}) {
  if (options.length === 0) return null;

  return (
    <Row align="center" wrap gap="sm">
      <span className="font-medium text-muted-foreground text-xs">
        {label}:
      </span>
      {options.map((option) => (
        <ToggleBadge
          key={option}
          label={formatLabel(option)}
          active={selected.has(option)}
          onClick={() => onToggle(option)}
        />
      ))}
    </Row>
  );
}

export function DashboardFilters({
  filters,
  onFiltersChange,
  availableStatuses,
  availableKinds,
  availableLocations,
  availableYears,
}: {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  availableStatuses: string[];
  availableKinds: string[];
  availableLocations: string[];
  /** Distinct years present in purchase/task dates, newest first. */
  availableYears: string[];
}) {
  const hasFilters =
    filters.statuses.size > 0 ||
    filters.kinds.size > 0 ||
    filters.locations.size > 0 ||
    filters.dateRange !== null;

  function toggle(key: "statuses" | "kinds" | "locations", value: string) {
    const next = new Set(filters[key]);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onFiltersChange({ ...filters, [key]: next });
  }

  return (
    <Stack gap="sm">
      <Row wrap gap="lg">
        <FilterGroup
          label="Status"
          options={availableStatuses}
          selected={filters.statuses}
          onToggle={(v) => toggle("statuses", v)}
          formatLabel={(v) => PROJECT_STATUS_LABELS[v as ProjectStatus] ?? v}
        />
        <FilterGroup
          label="Kind"
          options={availableKinds}
          selected={filters.kinds}
          onToggle={(v) => toggle("kinds", v)}
          formatLabel={capitalize}
        />
        <FilterGroup
          label="Location"
          options={availableLocations}
          selected={filters.locations}
          onToggle={(v) => toggle("locations", v)}
        />
        {/* Single-select: a union of date ranges isn't meaningful. Scopes
            purchases (by date) and tasks (by due date) — never projects. */}
        <Row align="center" wrap gap="sm">
          <span className="font-medium text-muted-foreground text-xs">
            Date:
          </span>
          {[
            ...DATE_RANGE_PRESETS,
            ...availableYears.map((y) => ({ key: y, label: y })),
          ].map(({ key, label }) => (
            <ToggleBadge
              key={key}
              label={label}
              active={filters.dateRange === key}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  dateRange: filters.dateRange === key ? null : key,
                })
              }
            />
          ))}
        </Row>
      </Row>
      {hasFilters && (
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={() => onFiltersChange(emptyFilters)}
        >
          Clear filters
        </button>
      )}
    </Stack>
  );
}
