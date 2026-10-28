import type {
  CalendarItemKind,
  CalendarSourceKind,
} from "@cubby/schemas/calendar";
import { calendarSourceEntity } from "@cubby/schemas/calendar";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { ListSlotProps } from "~/entity/entity-list/list-slot-types";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entity/filters";
import { useDeferredReferenceFilterOptions } from "~/entity/hooks/use-deferred-reference-filter-options";
import { useEntityMetadata } from "~/entity/metadata";
import { ManifestFilterBar } from "~/entity/table/manifest-filter-bar";
import { CopyLastWeekButton } from "~/features/meal/copy-meals";

import { calendarEntityFilterSpecs } from "./calendar-filter-specs";
import { calendarPeriodParam, calendarDateParam } from "./calendar-search";
import { UnifiedCalendar } from "./unified-calendar";

const REPLACE = { replace: true } as const;

export function entityCalendar(kind: CalendarItemKind) {
  const source: CalendarSourceKind =
    kind === "expense" || kind === "purchase" ? "spending" : kind;
  const kinds: CalendarSourceKind[] = [source];
  return function EntityCalendar({ search, navigate }: ListSlotProps) {
    const queryClient = useQueryClient();
    useEntityMetadata(calendarSourceEntity(source));
    const specs = useMemo(
      () => calendarEntityFilterSpecs(queryClient, source),
      [queryClient],
    );
    const period = calendarPeriodParam.parse(search.period) ?? "month";
    const filterOptions = useDeferredReferenceFilterOptions(
      calendarSourceEntity(source),
    );
    const filters = useMemo(
      () => ({
        filters: {
          [source]: buildFiltersFromManifest(
            specs,
            filterGetterFromSearch(specs, search),
          ),
        },
      }),
      [search, specs],
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
