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

type DateSpanParts = { label: string; relative: string | null };

function dateSpanParts(
  start: string | null,
  end: string | null,
  today: string,
  distance: "words" | "compact",
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
  return {
    label: `${monthDayRange(first, last)}${yearSuffix}`,
    relative,
  };
}

/** "Sep 22 – 25" inside one month, "Sep 30 – Oct 2" across months. */
function monthDayRange(first: string, last: string) {
  const endText =
    first.slice(5, 7) === last.slice(5, 7)
      ? String(Number(last.slice(8)))
      : formatCalendarDay(last, "monthDay");
  return `${formatCalendarDay(first, "monthDay")} – ${endText}`;
}

/** A year as the stacked cell's muted mark: "’25". */
export const yearMark = (year: string) => `’${year.slice(-2)}`;

/** A stacked cell's day line and its muted distance line. */
export type StackedDate = { primary: string; secondary: string | null };

/**
 * The stacked table-cell form of `formatDateSpan`: the day ("Sep 3",
 * "Sep 30 – Oct 2") over its compact distance ("5d ago", "in 7mo"). A year
 * other than the household's current one leads the distance line ("’25 ·
 * 1y ago") so the day line, which sets the column's width, stays short.
 */
export function stackedDateSpan(
  start: string | null,
  end: string | null,
  today: string = householdLocalDate(),
): StackedDate {
  const first = start ?? end;
  const last = start === null || end === start ? null : end;
  const parts = dateSpanParts(start, end, today, "compact");
  if (first === null || parts.relative === null)
    return { primary: parts.label, secondary: parts.relative };
  const years = [
    ...new Set([first, last ?? first].map((day) => day.slice(0, 4))),
  ];
  const primary =
    last === null
      ? formatCalendarDay(first, "monthDay")
      : monthDayRange(first, last);
  const shown =
    years.length === 1 && years[0] === today.slice(0, 4) ? [] : years;
  return {
    primary,
    secondary: [shown.map(yearMark).join("–"), parts.relative]
      .filter(Boolean)
      .join(" · "),
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
