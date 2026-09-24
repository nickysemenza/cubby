import {
  projectStatusSchema,
  projectStatusValues,
} from "@cubby/schemas/project";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { type ReactNode, useId, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

import {
  activeFilterCount,
  DATE_RANGE_PRESETS,
  type Filters,
  hasActiveFilters,
} from "./dashboard-filter-state";
import { FilterChipGroup, SingleSelectChipGroup } from "./filter-chips";
import { capitalize, PROJECT_STATUS_LABELS } from "./project-formatting";

const DATE_PRESET_LABELS = new Map<string, string>(
  DATE_RANGE_PRESETS.map(({ key, label }) => [key, label]),
);

type DashboardFiltersProps = {
  filters: Filters;
  onFiltersChange: (filters: Filters) => void;
  availableKinds: string[];
  availableLocations: string[];
  /** Distinct years present in expense/task dates, newest first. */
  availableYears: string[];
  availableCompletionYears: string[];
  savedViews: ReactNode;
};

/**
 * The project scope stays in the URL, but its detailed controls no longer
 * compete with the dashboard's first decision. The compact trigger shows the
 * active count; the responsive dialog carries saved views and all fields.
 */
export function DashboardFilters(props: DashboardFiltersProps) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(props.filters);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={count > 0 ? `Filters, ${count} active` : "Filter projects"}
      >
        <FunnelIcon />
        {count > 0 ? `Filters (${count})` : "Filter"}
      </Button>

      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title="Project filters"
        description="Narrow projects, work, and spend together."
        size="lg"
        footer={
          <Row justify="end">
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </Row>
        }
      >
        <DashboardFilterControls {...props} />
      </ResponsiveDialog>
    </>
  );
}

function DashboardFilterControls({
  filters,
  onFiltersChange,
  availableKinds,
  availableLocations,
  availableYears,
  availableCompletionYears,
  savedViews,
}: DashboardFiltersProps) {
  const yearId = useId();
  const completionYearId = useId();

  function toggle(key: "statuses" | "kinds" | "locations", value: string) {
    const next = new Set(filters[key]);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onFiltersChange({ ...filters, [key]: next });
  }

  const selectedYear = /^\d{4}$/.test(filters.dateRange ?? "")
    ? (filters.dateRange ?? "")
    : "";
  return (
    <Stack gap="lg">
      {savedViews}

      <Stack gap="md">
        <FilterChipGroup
          label="Status"
          options={[...projectStatusValues]}
          selected={filters.statuses}
          onToggle={(v) => toggle("statuses", v)}
          formatLabel={(v) => {
            const status = projectStatusSchema.safeParse(v);
            return status.success ? PROJECT_STATUS_LABELS[status.data] : v;
          }}
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
            expenses (by date), tasks (by due date), and the project set (by
            interval overlap) — undated projects drop out of that last one
            while a window is set. */}
        <SingleSelectChipGroup
          label="Date range"
          options={DATE_RANGE_PRESETS.map(({ key }) => key)}
          value={filters.dateRange}
          onChange={(dateRange) => onFiltersChange({ ...filters, dateRange })}
          formatLabel={(v) => DATE_PRESET_LABELS.get(v) ?? v}
          hint="narrows expenses, tasks & projects by date"
        />
        <Stack gap="xs">
          <label
            htmlFor={yearId}
            className="font-mono text-2xs tracking-wider text-muted-foreground uppercase"
          >
            Calendar year
          </label>
          <NativeSelect
            id={yearId}
            value={selectedYear}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                dateRange: event.currentTarget.value || null,
              })
            }
          >
            <option value="">Any year</option>
            {availableYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </NativeSelect>
        </Stack>
        <Stack gap="xs">
          <label
            htmlFor={completionYearId}
            className="font-mono text-2xs tracking-wider text-muted-foreground uppercase"
          >
            Completed
          </label>
          <NativeSelect
            id={completionYearId}
            value={filters.completionYear ?? ""}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                completionYear: event.currentTarget.value || null,
              })
            }
          >
            <option value="">Any completion year</option>
            {availableCompletionYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </NativeSelect>
        </Stack>
      </Stack>
    </Stack>
  );
}

/** The active URL scope belongs in the working surface, not hidden inside the
 * dialog that changes it. Absent for bare `/projects`. */
export function ActiveScopeSummary({
  filters,
  onClear,
}: {
  filters: Filters;
  onClear: () => void;
}) {
  const scopeSummary = activeScopeSummary(filters);
  if (scopeSummary.length === 0) return null;

  return (
    <Row align="center" justify="between" gap="sm" wrap>
      <p className="text-xs text-muted-foreground">
        {scopeSummary.join(" · ")}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </Row>
  );
}

function activeScopeSummary(filters: Filters): string[] {
  if (!hasActiveFilters(filters)) return [];

  return [
    ...[...filters.statuses].map(
      (status) => PROJECT_STATUS_LABELS[status] ?? status,
    ),
    ...[...filters.kinds].map(capitalize),
    ...filters.locations,
    ...(filters.dateRange
      ? [DATE_PRESET_LABELS.get(filters.dateRange) ?? filters.dateRange]
      : []),
    ...(filters.completionYear ? [`Completed ${filters.completionYear}`] : []),
  ];
}
