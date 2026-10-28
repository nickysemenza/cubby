import { useMemo } from "react";

import { referenceFilterOptionsKey } from "~/entity/filter-manifest";
import { useDeferredEntityRosters } from "~/entity/hooks/use-deferred-reference-filter-options";
import { ManifestFilterBar } from "~/entity/table/manifest-filter-bar";

import {
  useCalendarFilterSpecs,
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
  const specs = useCalendarFilterSpecs();
  const references = useMemo(
    () =>
      (specs ?? []).flatMap((spec) => {
        const key = referenceFilterOptionsKey(spec);
        return key && spec.referenceEntity
          ? [{ key, target: spec.referenceEntity }]
          : [];
      }),
    [specs],
  );
  const filterOptions = useDeferredEntityRosters(references);
  const visibleSpecs = useMemo(
    () =>
      mode === "schedule" && specs ? calendarScheduleFilterSpecs(specs) : specs,
    [mode, specs],
  );
  if (!visibleSpecs) return null;

  return (
    <ManifestFilterBar
      className="md:[&_button]:h-6 md:[&_button]:min-h-0"
      specs={visibleSpecs}
      filterOptions={filterOptions}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}
