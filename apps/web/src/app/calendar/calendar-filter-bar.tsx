import { ManifestFilterBar } from "~/app/_components/data-table/ManifestFilterBar";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { calendarFilterSpecs } from "./calendar-filter-specs";

interface CalendarFilterBarProps {
  search: Record<string, unknown>;
  onSearchChange: (params: Record<string, string | undefined>) => void;
}

/** Supplies the calendar's runtime picklists to the shared manifest bar. */
export function CalendarFilterBar({
  search,
  onSearchChange,
}: CalendarFilterBarProps) {
  const projectOptions = useDeferredFilterOptions("project");
  const vendorOptions = useDeferredFilterOptions("vendor");
  const filterOptions = useFilterOptions({
    project: projectOptions,
    vendor: vendorOptions,
  });

  return (
    <ManifestFilterBar
      specs={calendarFilterSpecs}
      filterOptions={filterOptions}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}
