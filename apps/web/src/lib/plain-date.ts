/**
 * Shared helpers for the app's "plain date" convention: a timezone-free
 * "YYYY-MM-DD" string (project `startDate`/`endDate`, task
 * `dueDate`/`dueEndDate`, purchase `date` — see `plainDate` in
 * `@cubby/schemas/project`). These convert to/from a local-midnight `Date`
 * for display and for date-picker UIs; nothing here should ever touch UTC.
 */

/**
 * Parse a "YYYY-MM-DD" plain-date string (no time component — a task due
 * date, a purchase date) into a local `Date` at midnight via its components,
 * rather than `new Date(isoString)` (which parses as UTC midnight and can
 * shift a day back for negative UTC offsets, e.g. US timezones).
 */
export function parsePlainDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

/**
 * Format a local `Date` (e.g. from a date-picker's `onSelect`) back into a
 * "YYYY-MM-DD" plain-date string, using its LOCAL date parts — never
 * `toISOString()`, which normalizes to UTC and can shift the date by a day.
 */
export function formatPlainDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
