import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Payment lines and statement rows may disagree by posting lag, never more.
 * Two semantics share this width and must stay apart: a payment line carries an
 * instant, a statement row carries only a calendar date. Comparing them as one
 * moves matches near midnight.
 */
const POSTING_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/** Two instants within the window, to the millisecond. */
export const withinPostingInstantWindow = (a: Date, b: Date): boolean =>
  Math.abs(a.getTime() - b.getTime()) <= POSTING_WINDOW_DAYS * DAY_MS;

/**
 * SQL form of the instant window for a timestamp expression against one
 * instant. Both sides are UTC epoch seconds, independent of the session time
 * zone; the instant is floored to the second.
 */
export const withinPostingInstantWindowSql = (
  column: SQLWrapper,
  instant: Date,
): SQL =>
  sql`abs(extract(epoch FROM ${column}) - ${Math.floor(instant.getTime() / 1_000)}) <= ${POSTING_WINDOW_DAYS * 86_400}`;

/**
 * The UTC calendar days that bracket every statement date within the instant
 * window of any of these instants (milliseconds): a superset prefilter, not a
 * match.
 */
export const postingWindowDayBounds = (instantsMs: readonly number[]) => {
  // oxlint-disable-next-line cubby/no-ad-hoc-calendar-day -- matches paymentKey's UTC day
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    from: day(Math.min(...instantsMs) - POSTING_WINDOW_DAYS * DAY_MS),
    to: day(Math.max(...instantsMs) + POSTING_WINDOW_DAYS * DAY_MS),
  };
};

/** Two `YYYY-MM-DD` dates within the window, each read as its UTC midnight. */
export const withinPostingDateWindow = (a: string, b: string): boolean =>
  Math.abs(Date.parse(a) - Date.parse(b)) <= POSTING_WINDOW_DAYS * DAY_MS;
