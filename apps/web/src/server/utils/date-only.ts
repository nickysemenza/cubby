/**
 * The UTC calendar day of `value` as `YYYY-MM-DD` (today when omitted).
 *
 * UTC, not household-local: this is for stored date-only strings and
 * comparisons against them. A local "today" belongs in `~/lib/household-date`.
 */
export const dateOnly = (value: Date = new Date()): string =>
  value.toISOString().slice(0, 10);
