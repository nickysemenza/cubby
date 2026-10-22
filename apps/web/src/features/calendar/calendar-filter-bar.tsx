import { referenceFilterOptionsKey } from "~/entity/filter-manifest";
import { useDeferredEntityRosters } from "~/entity/hooks/use-deferred-reference-filter-options";
import { ManifestFilterBar } from "~/entity/table/manifest-filter-bar";

import {
  calendarFilterSpecs,
  calendarScheduleFilterSpecs,
} from "./calendar-filter-specs";

const CALENDAR_REFERENCES = calendarFilterSpecs.flatMap((spec) => {
  const key = referenceFilterOptionsKey(spec);
  return key && spec.referenceEntity
    ? [{ key, target: spec.referenceEntity }]
    : [];
});

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
  const filterOptions = useDeferredEntityRosters(CALENDAR_REFERENCES);

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
