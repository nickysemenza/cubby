import { type Component, casual, type Weekday } from "chrono-node/en";
import { addDays, addMonths, addWeeks, addYears, nextDay } from "date-fns";
import { formatPlainDate } from "~/lib/plain-date";

const PLAIN_DATE_INPUT_ERROR =
  "Couldn’t understand that date. Try ‘Aug 18, 2026’ or ‘next Friday’.";

export type PlainDateInputResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const WEEKDAYS: Readonly<Record<string, Weekday>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const FROM_WEEKDAY_PATTERN =
  /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(days?|weeks?|months?|years?)\s+from\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i;

const TIME_COMPONENTS: readonly Component[] = [
  "hour",
  "minute",
  "second",
  "millisecond",
  "meridiem",
  "timezoneOffset",
];

function parseNumber(value: string): number | null {
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[value.toLowerCase()] ?? null;
}

/**
 * Chrono treats "two weeks from Thursday" as a bare Thursday and leaves the
 * leading duration unmatched. Resolve that common shape explicitly so the
 * complete-input guard below can stay strict instead of silently ignoring
 * unparsed words.
 */
function parseDurationFromWeekday(
  input: string,
  referenceDate: Date,
): Date | null {
  const match = FROM_WEEKDAY_PATTERN.exec(input);
  if (!match) return null;

  const amountText = match[1];
  const unit = match[2]?.toLowerCase();
  const weekdayText = match[3]?.toLowerCase();
  if (!amountText || !unit || !weekdayText) return null;

  const amount = parseNumber(amountText);
  const weekday = WEEKDAYS[weekdayText];
  if (amount === null || weekday === undefined) return null;

  const base = nextDay(referenceDate, weekday);
  if (unit.startsWith("day")) return addDays(base, amount);
  if (unit.startsWith("week")) return addWeeks(base, amount);
  if (unit.startsWith("month")) return addMonths(base, amount);
  return addYears(base, amount);
}

/**
 * Parse one English-US calendar-date expression into Cubby's timezone-free
 * plain-date value. The complete input must resolve to exactly one date; time
 * expressions, ranges, and prose containing an incidental date are rejected.
 */
export function parsePlainDateInput(
  rawInput: string,
  referenceDate = new Date(),
): PlainDateInputResult {
  const input = rawInput.trim().replace(/\s+/g, " ");
  if (input === "") return { ok: true, value: null };

  const durationFromWeekday = parseDurationFromWeekday(input, referenceDate);
  if (durationFromWeekday) {
    return { ok: true, value: formatPlainDate(durationFromWeekday) };
  }

  const results = casual.parse(input, referenceDate);
  const result = results[0];
  const parsedDate = result?.start.date();
  if (
    results.length !== 1 ||
    !result ||
    result.index !== 0 ||
    result.text.length !== input.length ||
    result.end ||
    TIME_COMPONENTS.some((component) => result.start.isCertain(component)) ||
    !parsedDate ||
    Number.isNaN(parsedDate.getTime())
  ) {
    return { ok: false, error: PLAIN_DATE_INPUT_ERROR };
  }

  return { ok: true, value: formatPlainDate(parsedDate) };
}
