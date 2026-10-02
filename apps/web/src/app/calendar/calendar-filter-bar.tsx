import { ManifestFilterBar } from "~/ui/data-table/ManifestFilterBar";
import { useDeferredFilterOptions } from "~/ui/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";

import {
  calendarFilterSpecs,
  calendarScheduleFilterSpecs,
} from "./calendar-filter-specs";

interface CalendarFilterBarProps {
  search: Readonly<Record<string, string | undefined>>;
  onSearchChange: (params: Record<string, string | undefined>) => void;
  mode?: "calendar" | "schedule";
}

/** Supplies the calendar's runtime picklists to the shared manifest bar. */
export function CalendarFilterBar({
  search,
  onSearchChange,
  mode = "calendar",
}: CalendarFilterBarProps) {
  const projectOptions = useDeferredFilterOptions("project");
  const vendorOptions = useDeferredFilterOptions("vendor");
  const filterOptions = useFilterOptions({
    project: projectOptions,
    vendor: vendorOptions,
  });

  return (
    <ManifestFilterBar
      specs={
        mode === "schedule" ? calendarScheduleFilterSpecs : calendarFilterSpecs
      }
      filterOptions={filterOptions}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}
