import { formatCalendarDay } from "~/lib/date-format";
import { householdLocalDate, plainDateDaysBetween } from "~/lib/household-date";

const PLAIN_DATE = /^(\d{4})-(\d{2})-\d{2}$/;

/**
 * The one human format for a (start, optional end) plain-date span: "Sep 22",
 * "Sep 22 – 25", "Sep 30 – Oct 2". The year appears only when it is not the
 * household's current year, and on both ends when they differ in year. Past, present,
 * and future days include relative context; a range covering today is ongoing. A null
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
  if (!from || (last !== null && !to) || !validCalendarDays(first, last))
    return last === null ? first : `${first} – ${last}`;
  const relative = spanContext(first, last, today);
  const suffix = relative ? ` (${relative})` : "";
  const yearSuffix = from[1] === today.slice(0, 4) ? "" : `, ${from[1]}`;
  if (last === null || to === null)
    return `${formatCalendarDay(first, "monthDay")}${yearSuffix}${suffix}`;
  if (from[1] !== to[1])
    return `${formatCalendarDay(first, "dateShort")} – ${formatCalendarDay(last, "dateShort")}${suffix}`;
  const endText =
    from[2] === to[2]
      ? String(Number(last.slice(8)))
      : formatCalendarDay(last, "monthDay");
  return `${formatCalendarDay(first, "monthDay")} – ${endText}${yearSuffix}${suffix}`;
}

function spanContext(
  start: string,
  end: string | null,
  today: string,
): string | null {
  if (end !== null && start <= today && end >= today) return "ongoing";
  return calendarDayContext(
    plainDateDaysBetween(today, end !== null && end < today ? end : start),
  );
}

function validCalendarDays(...days: (string | null)[]): boolean {
  return days.every(
    (day) => day === null || formatCalendarDay(day, "dateShort") !== day,
  );
}

/** Calendar-day distance avoids elapsed-hour rounding at midnight and DST. */
function calendarDayContext(days: number): string | null {
  if (days < 0) {
    if (days === -1) return "yesterday";
    const future = calendarDayContext(-days);
    return future?.replace(/^in /, "").concat(" ago") ?? null;
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return "in a few days";
  if (days < 14) return "in about a week";
  if (days < 28) return "in a few weeks";
  if (days < 60) return "in about a month";
  if (days < 330) return "in a few months";
  if (days < 548) return "in about a year";
  return `in about ${Math.round(days / 365.2425)} years`;
}
