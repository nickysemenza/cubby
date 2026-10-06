/**
 * Date-picker adapters between a "YYYY-MM-DD" plain date and a `Date` at local
 * midnight in the runtime's zone — what react-day-picker and chrono-node
 * expect. Browser code only: on a Worker the runtime zone is UTC, so
 * `formatPlainDate(new Date())` there is a UTC day. Calendar arithmetic and
 * the day an instant happened on live in `~/lib/household-date`.
 */

/**
 * Parse a plain date into a local `Date` at midnight via its components,
 * rather than `new Date(isoString)` (which parses as UTC midnight and can
 * shift a day back for negative UTC offsets, e.g. US timezones).
 */
export function parsePlainDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/**
 * Format a local `Date` (e.g. from a date-picker's `onSelect`) back into a
 * plain date using its LOCAL date parts — never `toISOString()`, which
 * normalizes to UTC and can shift the date by a day.
 */
export function formatPlainDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
