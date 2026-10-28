import { type CalendarFiltersInput } from "@cubby/schemas/calendar";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  buildFiltersFromManifest,
  compileFilterCodec,
  filterGetterFromSearch,
} from "~/entity/filters";

import {
  calendarEntityFilterSpecs,
  calendarFilterKey,
  calendarKinds,
} from "./calendar-filter-specs";

export type CalendarFilters = CalendarFiltersInput;

export function buildCalendarFilters(
  queryClient: QueryClient,
  search: import("~/entity/entity-list/list-slot-types").ListSearch,
): CalendarFilters {
  const filters = Object.fromEntries(
    calendarKinds.flatMap((kind) => {
      const specs = calendarEntityFilterSpecs(queryClient, kind);
      const sourceSearch = Object.fromEntries(
        compileFilterCodec(specs).keys.map((key) => [
          key,
          search[calendarFilterKey(kind, key)],
        ]),
      );
      const values = buildFiltersFromManifest(
        specs,
        filterGetterFromSearch(specs, sourceSearch),
      );
      return Object.values(values).some((value) => value !== undefined)
        ? [[kind, values]]
        : [];
    }),
  );
  return {
    kinds:
      typeof search.kinds === "string" && search.kinds
        ? z.array(z.enum(calendarKinds)).parse(search.kinds.split(","))
        : undefined,
    filters,
  };
}
