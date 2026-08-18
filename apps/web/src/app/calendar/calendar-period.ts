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

function householdCalendarDate(plainDate: string) {
  const parsed = parsePlainDate(plainDate);
  return new TZDate(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    HOUSEHOLD_TIMEZONE,
  );
}

function getCalendarPeriodRange(anchor: Date, period: CalendarPeriod) {
  const activeStart =
    period === "week"
      ? startOfWeek(anchor, { weekStartsOn: 0 })
      : startOfMonth(anchor);
  const activeEnd =
    period === "week"
      ? addWeeks(activeStart, 1)
      : addDays(endOfMonth(anchor), 1);
  if (period === "week") {
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
  period: CalendarPeriod,
  direction: -1 | 1,
) {
  return period === "week"
    ? addWeeks(anchor, direction)
    : addMonths(anchor, direction);
}

function formatCalendarPeriodTitle(
  anchor: Date,
  period: CalendarPeriod,
  activeEnd: Date,
) {
  if (period === "month") return format(anchor, "MMMM yyyy");
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
