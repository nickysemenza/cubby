import {
  type CalendarFiltersInput,
  calendarFiltersInput,
} from "@cubby/schemas/calendar";

import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
} from "~/entities/filters";

import { calendarFilterSpecs } from "./calendar-filter-specs";

export type CalendarFilters = CalendarFiltersInput;

/**
 * URL search params → the filter half of `calendar.range`'s input.
 *
 * Reads through the same `decodeFilters` the chip bar renders from, so the
 * visible chips and the query can't disagree about what the URL says.
 */
export function buildCalendarFilters(
  search: Record<string, unknown>,
): CalendarFilters {
  const filters = calendarFiltersInput.parse(
    buildFiltersFromManifest(
      calendarFilterSpecs,
      filterGetterFromSearch(calendarFilterSpecs, search),
    ),
  );
  // Always subtree-expanded, with no spec and no URL key: a project's calendar
  // BAR is already the subtree-folded window, so scoping to a parent without
  // its descendants would draw a span covering dates whose tasks and expenses
  // are hidden — a contradiction on the same pixels. This is a property of the
  // view, not a choice the user should have to make. (The expense ledger
  // exposes `?subprojects=` because it is deep-linked from a project summary
  // and has to reconcile against it; the calendar is not.)
  return filters.projectId ? { ...filters, includeSubProjects: true } : filters;
}
