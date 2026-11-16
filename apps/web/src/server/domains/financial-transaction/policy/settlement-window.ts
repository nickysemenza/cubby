/**
 * Payment lines and statement rows may disagree by posting lag, never more.
 * Two semantics share this width and must stay apart: a payment line carries an
 * instant, a statement row carries only a calendar date. Comparing them as one
 * moves matches near midnight.
 */
export const POSTING_WINDOW_DAYS = 3;
const DAY_MS = 86_400_000;

/** Two instants within the window, to the millisecond. */
export const withinPostingInstantWindow = (a: Date, b: Date): boolean =>
  Math.abs(a.getTime() - b.getTime()) <= POSTING_WINDOW_DAYS * DAY_MS;

/** Two `YYYY-MM-DD` dates within the window, each read as its UTC midnight. */
export const withinPostingDateWindow = (a: string, b: string): boolean =>
  Math.abs(Date.parse(a) - Date.parse(b)) <= POSTING_WINDOW_DAYS * DAY_MS;
