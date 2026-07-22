/**
 * Single-user household — hardcoded rather than configurable.
 */
export const HOUSEHOLD_TIMEZONE = "America/Los_Angeles";

/**
 * Household-local calendar date, e.g. "2026-07-22". Never derive this via
 * `date.toISOString().slice(0, 10)` (a UTC day — misreads a same-day
 * deadline as overdue after ~5pm PT) or bare `new Date()` field access on a
 * server that doesn't run in the household's timezone (Cloudflare Workers
 * run in UTC). The `en-CA` locale is the standard trick for getting
 * `Intl.DateTimeFormat` to emit ISO (`yyyy-MM-dd`) order directly.
 */
export function householdLocalDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HOUSEHOLD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Household-local calendar date `days` ago, for activity-cutoff checks. */
export function householdDaysAgo(
  days: number,
  from: Date = new Date(),
): string {
  return householdLocalDate(
    new Date(from.getTime() - days * 24 * 60 * 60 * 1000),
  );
}

/** Household-local calendar date `days` from now, for "due within" checks. */
export function householdDaysFromNow(
  days: number,
  from: Date = new Date(),
): string {
  return householdLocalDate(
    new Date(from.getTime() + days * 24 * 60 * 60 * 1000),
  );
}
