import { TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  format,
  isSameMonth,
  isSameYear,
  startOfMonth,
  startOfWeek,
} from "date-fns";

import type { CalendarPeriod } from "~/components/reui/event-calendar/event-calendar-types";
import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { parsePlainDate } from "~/lib/plain-date";

export type CalendarViewPeriod = CalendarPeriod | "schedule";

function householdCalendarDate(plainDate: string) {
  const parsed = parsePlainDate(plainDate);
  return new TZDate(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    HOUSEHOLD_TIMEZONE,
  );
}

/** Weeks a period covers when it is week-aligned; month is not. */
const WEEK_ALIGNED_SPAN = new Map<CalendarViewPeriod, number>([
  ["week", 1],
  ["fortnight", 2],
]);

function getCalendarPeriodRange(anchor: Date, period: CalendarViewPeriod) {
  const weeks = WEEK_ALIGNED_SPAN.get(period);
  const activeStart = weeks
    ? startOfWeek(anchor, { weekStartsOn: 0 })
    : startOfMonth(anchor);
  const activeEnd = weeks
    ? addWeeks(activeStart, weeks)
    : addDays(endOfMonth(anchor), 1);
  if (weeks || period === "schedule") {
    return {
      activeStart,
      activeEnd,
      visibleStart: activeStart,
      visibleEnd: activeEnd,
    };
  }
  const visibleStart = startOfWeek(activeStart, { weekStartsOn: 0 });
  const visibleEnd = addDays(visibleStart, 42);
  return { activeStart, activeEnd, visibleStart, visibleEnd };
}

function shiftCalendarPeriod(
  anchor: Date,
  period: CalendarViewPeriod,
  direction: -1 | 1,
) {
  const weeks = WEEK_ALIGNED_SPAN.get(period);
  return weeks
    ? addWeeks(anchor, direction * weeks)
    : addMonths(anchor, direction);
}

function formatCalendarPeriodTitle(
  anchor: Date,
  period: CalendarViewPeriod,
  activeEnd: Date,
) {
  if (period === "month" || period === "schedule")
    return format(anchor, "MMMM yyyy");
  // Week and fortnight share the compact range label; `anchor` is the period's
  // first day for both, so the branches below need no period of their own.
  const end = addDays(activeEnd, -1);
  if (isSameMonth(anchor, end)) {
    return `${format(anchor, "MMM d")}–${format(end, "d, yyyy")}`;
  }
  if (isSameYear(anchor, end)) {
    return `${format(anchor, "MMM d")}–${format(end, "MMM d, yyyy")}`;
  }
  return `${format(anchor, "MMM d, yyyy")}–${format(end, "MMM d, yyyy")}`;
}

export {
  formatCalendarPeriodTitle,
  getCalendarPeriodRange,
  householdCalendarDate,
  shiftCalendarPeriod,
};
