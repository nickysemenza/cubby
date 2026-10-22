import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { calendarFiltersInput } from "@cubby/schemas/calendar";
import { useCallback, useMemo } from "react";

import type { ListSlotProps } from "~/entity/entity-list/list-slot-types";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entity/filters";
import { useDeferredReferenceFilterOptions } from "~/entity/hooks/use-deferred-reference-filter-options";
import { ManifestFilterBar } from "~/entity/table/manifest-filter-bar";
import { CopyLastWeekButton } from "~/features/meal/copy-meals";

import { calendarEntityFilterSpecs } from "./calendar-filter-specs";
import { calendarPeriodParam, calendarDateParam } from "./calendar-search";
import { UnifiedCalendar } from "./unified-calendar";

const REPLACE = { replace: true } as const;

export function entityCalendar(kind: CalendarItemKind) {
  const kinds = [kind];
  const specs = calendarEntityFilterSpecs[kind]!;
  return function EntityCalendar({ search, navigate }: ListSlotProps) {
    const period = calendarPeriodParam.parse(search.period) ?? "month";
    const filterOptions = useDeferredReferenceFilterOptions(kind);
    const filters = useMemo(
      () =>
        calendarFiltersInput.parse({
          filters: {
            [kind]: buildFiltersFromManifest(
              specs,
              filterGetterFromSearch(specs, search),
            ),
          },
        }),
      [search],
    );
    const onSearchChange = useCallback(
      (patch: Record<string, string | undefined>) => navigate(patch, REPLACE),
      [navigate],
    );
    return (
      <>
        <ManifestFilterBar
          specs={specs}
          search={search}
          filterOptions={filterOptions}
          onSearchChange={onSearchChange}
        />
        <UnifiedCalendar
          period={period}
          date={calendarDateParam.parse(search.calendarDate)}
          lockedKinds={kinds}
          filters={filters}
          periodActions={
            kind === "meal" && period === "week"
              ? (range) => <CopyLastWeekButton weekStart={range.startDate} />
              : undefined
          }
          onPeriodChange={(next) =>
            navigate({ period: next === "month" ? undefined : next }, REPLACE)
          }
          onDateChange={(next) => navigate({ calendarDate: next }, REPLACE)}
        />
      </>
    );
  };
}
