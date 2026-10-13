import { TZDate } from "@date-fns/tz";
import { format, formatDistance } from "date-fns";

import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { parsePlainDate } from "~/lib/plain-date";

/**
 * The app's display date/time shapes, as date-fns patterns. Every date shown
 * to the household goes through one of these via `formatInstant` or
 * `formatCalendarDay` — no inline `toLocale*String`, `Intl.DateTimeFormat`, or
 * `format(date, "...")` — so a value renders the same wherever it appears and
 * always in the household zone. Fixed en-US-shaped output (plain space before
 * AM/PM), independent of the runtime locale.
 */
const DATE_PRESETS = {
  /** Jan 5, 2026 */
  dateShort: "MMM d, yyyy",
  /** Jan 05, 2026 — zero-padded day for fixed-width mono eyebrows. */
  dateShortPadded: "MMM dd, yyyy",
  /** Jan 5, 2026, 1:04 PM */
  dateShortTime: "MMM d, yyyy, h:mm a",
  /** 1/5/2026 */
  dateNumeric: "M/d/yyyy",
  /** 1/5/2026, 1:04:09 PM */
  dateTime: "M/d/yyyy, h:mm:ss a",
  /** 1:04:09 PM */
  time: "h:mm:ss a",
  /** 2026-01-05 13:04 */
  isoDateTime: "yyyy-MM-dd HH:mm",
  /** 2026-01-05 13:04:09 */
  isoDateTimeSeconds: "yyyy-MM-dd HH:mm:ss",
  /** Exact household timestamp, including its zone offset. */
  timestampExact: "yyyy-MM-dd HH:mm:ss zzz",
  /** Jan 5 */
  monthDay: "MMM d",
  /** Jan 5, 1:04 PM */
  monthDayTime: "MMM d, h:mm a",
  /** Jan */
  monthShort: "MMM",
  /** Jan 2026 */
  monthYear: "MMM yyyy",
  /** Jan 26 */
  monthYearCompact: "MMM yy",
  /** January 2026 */
  monthYearLong: "MMMM yyyy",
  /** Mon, Jan 5 */
  weekdayMonthDay: "EEE, MMM d",
  /** Mon 1/5 */
  weekdayNumeric: "EEE M/d",
  /** Monday, January 5 */
  weekdayLongMonthDay: "EEEE, MMMM d",
  /** Mon, Jan 05, 2026 */
  weekdayDatePadded: "EEE, MMM dd, yyyy",
} as const;

export type DatePreset = keyof typeof DATE_PRESETS;

/**
 * Format a point in time (a Date, ISO string, or epoch ms — createdAt,
 * startedAt, receivedAt) in the household zone unless `timeZone` pins another
 * one (the build date is pinned to "UTC" so server and client agree).
 *
 * Unparseable input yields "Invalid Date", as `Date#toLocaleString` did;
 * date-fns `format` would throw mid-render. Null handling and fallbacks
 * ("Never", "—") stay at the call site, which knows the right word.
 */
export function formatInstant(
  value: Date | string | number,
  preset: DatePreset,
  timeZone: string = HOUSEHOLD_TIMEZONE,
): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Invalid Date";
  return format(new TZDate(instant, timeZone), DATE_PRESETS[preset]);
}

export const DAYS_PER_MONTH = 30.4375;
export const DAYS_PER_YEAR = 365.2425;

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Format a calendar day with no zone conversion: a plain "YYYY-MM-DD" string
 * (task due dates, expense dates), or a `Date`/`TZDate` that is already a
 * calendar cell (a calendar grid day, an anchor). A string is read by its
 * components via `parsePlainDate` — never `new Date("2026-01-05")`, which is
 * UTC midnight and shows the previous day in the household zone. A `Date` is
 * read by its own components, so a `TZDate` keeps its zone.
 *
 * Anything that is not a real calendar day is returned unchanged rather than
 * thrown on.
 */
export function formatCalendarDay(
  value: string | Date,
  preset: DatePreset,
): string {
  if (value instanceof Date) return format(value, DATE_PRESETS[preset]);
  if (!PLAIN_DATE.test(value)) return value;
  const day = parsePlainDate(value);
  // parsePlainDate rolls "2026-13-45" over into a later real date; a round
  // trip through the components catches that.
  const [year, month, date] = value.split("-").map(Number);
  if (
    day.getFullYear() !== year ||
    day.getMonth() + 1 !== month ||
    day.getDate() !== date
  ) {
    return value;
  }
  return format(day, DATE_PRESETS[preset]);
}

/** Elapsed time from now, independent of the display zone. */
export function formatRelative(
  value: Date | string | number,
  now: number = Date.now(),
): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Invalid Date";
  if (Math.abs(now - instant.getTime()) < 45_000) return "now";
  return formatDistance(instant, now, { addSuffix: true });
}

/** Compact table distance; minutes and months have unambiguous units. */
export function formatCompactRelative(
  value: Date | string | number,
  now: number = Date.now(),
): string {
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) return "Invalid Date";
  const seconds = Math.round(Math.abs(now - instant) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const amount =
    minutes < 60
      ? `${minutes} min`
      : hours < 24
        ? `${hours}h`
        : days < 7
          ? `${days}d`
          : days < 30
            ? `${Math.round(days / 7)}w`
            : days < 365
              ? `${Math.min(11, Math.round(days / DAYS_PER_MONTH))} mo`
              : `${Math.round(days / DAYS_PER_YEAR)}y`;
  return instant > now ? `in ${amount}` : `${amount} ago`;
}

/** String-only captions share DateDisplay's full timestamp presentation. */
export function formatTimestamp(
  value: Date | string | number,
  now: number = Date.now(),
): string {
  const label = formatInstant(value, "dateShortTime");
  return label === "Invalid Date"
    ? label
    : `${label} · ${formatRelative(value, now)}`;
}
