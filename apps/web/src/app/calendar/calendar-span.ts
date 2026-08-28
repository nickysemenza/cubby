import type { CalendarItem } from "@cubby/schemas/calendar";
import { addDays } from "date-fns";

import { formatDateRange } from "~/app/projects/project-formatting";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";

/**
 * The inclusive date range of a MULTI-day calendar item, or null for a
 * single-day one.
 *
 * Long spans are the reason this exists: a project running Oct 3 -> Nov 12
 * draws one bar per week row, so the month grid repeats the same title five or
 * six times without ever saying where the span begins or ends. The items
 * already carry their true window — `repo/calendar.ts` filters by the queried
 * range but never clips the dates to it — so the label is honest even on a
 * segment whose start and end are both off-screen.
 *
 * Single-day items return null rather than a degenerate "Oct 3 — Oct 3": the
 * cell and the day-sheet header already name that date. The test is structural
 * rather than a `kind` switch, which covers meals and expenses (the repo always
 * writes `date + 1`) and 1-day tasks with one predicate.
 */
export function itemSpanLabel(item: CalendarItem): string | null {
  const start = parsePlainDate(item.startDate);
  // `endDateExclusive` is exclusive, so the inclusive end is one day back —
  // the same shift `persistMove` applies when it writes a task's `dueEndDate`.
  const endInclusive = addDays(parsePlainDate(item.endDateExclusive), -1);
  if (endInclusive.getTime() <= start.getTime()) return null;
  return formatDateRange(item.startDate, formatPlainDate(endInclusive));
}
