import type { ProjectStatus } from "@cubby/schemas/project";
import { projectStatusValues } from "@cubby/schemas/project";
import { Row, Stack } from "~/components/layout";
import {
  DATE_RANGE_PRESETS,
  defaultFilters,
  type Filters,
  isDefaultStatusSelection,
} from "./dashboard-filter-state";
import { FilterChipGroup, SingleSelectChipGroup } from "./filter-chips";
import { capitalize, PROJECT_STATUS_LABELS } from "./project-formatting";

const DATE_PRESET_LABELS = new Map<string, string>(
  DATE_RANGE_PRESETS.map(({ key, label }) => [key, label]),
);

export function DashboardFilters({
  filters,
  onFiltersChange,
  availableKinds,
  availableLocations,
  availableYears,
}: {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  availableKinds: string[];
  availableLocations: string[];
  /** Distinct years present in purchase/task dates, newest first. */
  availableYears: string[];
}) {
  // Compares against `defaultFilters` (the live-three statuses, nothing
  // else), not an empty selection — so the resting first-load state, which
  // honestly reflects what the server scopes to, shows no affordance.
  const hasFilters =
    !isDefaultStatusSelection(filters) ||
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

  const dateOptions = [
    ...DATE_RANGE_PRESETS.map(({ key }) => key),
    ...availableYears,
  ];

  return (
    <Stack gap="sm">
      <Row wrap gap="lg">
        <FilterChipGroup
          label="Status"
          options={[...projectStatusValues]}
          selected={filters.statuses}
          onToggle={(v) => toggle("statuses", v)}
          formatLabel={(v) => PROJECT_STATUS_LABELS[v as ProjectStatus] ?? v}
        />
        <FilterChipGroup
          label="Kind"
          options={availableKinds}
          selected={filters.kinds}
          onToggle={(v) => toggle("kinds", v)}
          formatLabel={capitalize}
        />
        <FilterChipGroup
          label="Location"
          options={availableLocations}
          selected={filters.locations}
          onToggle={(v) => toggle("locations", v)}
        />
        {/* Single-select: a union of date ranges isn't meaningful. Narrows
            purchases (by date), tasks (by due date), and the project set (by
            interval overlap) — undated projects drop out of that last one
            while a window is set. */}
        <SingleSelectChipGroup
          label="Date range"
          options={dateOptions}
          value={filters.dateRange}
          onChange={(dateRange) => onFiltersChange({ ...filters, dateRange })}
          formatLabel={(v) => DATE_PRESET_LABELS.get(v) ?? v}
          hint="narrows purchases, tasks & projects by date"
        />
      </Row>
      {hasFilters && (
        <button
          type="button"
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={() => onFiltersChange(defaultFilters)}
        >
          Clear filters
        </button>
      )}
    </Stack>
  );
}
