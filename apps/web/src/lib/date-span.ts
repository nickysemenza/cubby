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
  const { label, relative } = dateSpanParts(start, end, today, "words");
  return relative ? `${label} (${relative})` : label;
}

/** A span's label and its distance from today, for separate lines. */
export type DateSpanParts = { label: string; relative: string | null };

/**
 * `formatDateSpan` as separate lines for a stacked table cell: the label, and
 * its distance from today in compact form ("5d ago", "in 7mo"), or null when
 * the value is not a readable span.
 */
export function dateSpanParts(
  start: string | null,
  end: string | null,
  today: string = householdLocalDate(),
  distance: "words" | "compact" = "compact",
): DateSpanParts {
  const first = start ?? end;
  if (first === null) return { label: "No date", relative: null };
  const last = start === null || end === start ? null : end;
  const from = PLAIN_DATE.exec(first);
  const to = last === null ? null : PLAIN_DATE.exec(last);
  if (!from || (last !== null && !to) || !validCalendarDays(first, last))
    return {
      label: last === null ? first : `${first} – ${last}`,
      relative: null,
    };
  const relative = spanContext(first, last, today, distance);
  const yearSuffix = from[1] === today.slice(0, 4) ? "" : `, ${from[1]}`;
  if (last === null || to === null)
    return {
      label: `${formatCalendarDay(first, "monthDay")}${yearSuffix}`,
      relative,
    };
  if (from[1] !== to[1])
    return {
      label: `${formatCalendarDay(first, "dateShort")} – ${formatCalendarDay(last, "dateShort")}`,
      relative,
    };
  const endText =
    from[2] === to[2]
      ? String(Number(last.slice(8)))
      : formatCalendarDay(last, "monthDay");
  return {
    label: `${formatCalendarDay(first, "monthDay")} – ${endText}${yearSuffix}`,
    relative,
  };
}

function spanContext(
  start: string,
  end: string | null,
  today: string,
  distance: "words" | "compact",
): string | null {
  if (end !== null && start <= today && end >= today) return "ongoing";
  const days = plainDateDaysBetween(
    today,
    end !== null && end < today ? end : start,
  );
  return distance === "words"
    ? calendarDayContext(days)
    : compactCalendarDayContext(days);
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

/** "today", "5d ago", "in 3w", "in 7mo", "2y ago" — calendar days, not hours. */
function compactCalendarDayContext(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  const magnitude = Math.abs(days);
  const amount =
    magnitude < 7
      ? `${magnitude}d`
      : magnitude < 30
        ? `${Math.round(magnitude / 7)}w`
        : magnitude < 365
          ? `${Math.max(1, Math.round(magnitude / 30.4375))}mo`
          : `${Math.round(magnitude / 365.2425)}y`;
  return days < 0 ? `${amount} ago` : `in ${amount}`;
}
