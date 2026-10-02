import { formatCalendarDay } from "~/lib/date-format";
import { householdLocalDate } from "~/lib/household-date";

const PLAIN_DATE = /^(\d{4})-(\d{2})-\d{2}$/;

/**
 * The one human format for a (start, optional end) plain-date span: "Sep 22",
 * "Sep 22 – 25", "Sep 30 – Oct 2". The year appears only when it is not the
 * household's current year, and on both ends when they differ in year. A null
 * or equal end collapses to a single day. Declared spans
 * (`presentation.spans`) and every ad hoc range label share this.
 */
export function formatDateSpan(
  start: string | null,
  end: string | null,
  today: string = householdLocalDate(),
): string {
  const first = start ?? end;
  if (first === null) return "No date";
  const last = start === null || end === start ? null : end;
  const from = PLAIN_DATE.exec(first);
  const to = last === null ? null : PLAIN_DATE.exec(last);
  if (!from || (last !== null && !to))
    return last === null ? first : `${first} – ${last}`;
  const yearSuffix = from[1] === today.slice(0, 4) ? "" : `, ${from[1]}`;
  if (last === null || to === null)
    return `${formatCalendarDay(first, "monthDay")}${yearSuffix}`;
  if (from[1] !== to[1])
    return `${formatCalendarDay(first, "dateShort")} – ${formatCalendarDay(last, "dateShort")}`;
  const endText =
    from[2] === to[2]
      ? String(Number(last.slice(8)))
      : formatCalendarDay(last, "monthDay");
  return `${formatCalendarDay(first, "monthDay")} – ${endText}${yearSuffix}`;
}
