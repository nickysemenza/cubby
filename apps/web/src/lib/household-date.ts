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
  return shiftHouseholdCalendarDate(from, -days);
}

/** Household-local calendar date `days` from now, for "due within" checks. */
export function householdDaysFromNow(
  days: number,
  from: Date = new Date(),
): string {
  return shiftHouseholdCalendarDate(from, days);
}

/**
 * Shift the household's calendar date, not an elapsed 24-hour duration.
 * Spring-forward days are 23 hours and fall-back days are 25; subtracting
 * milliseconds can therefore skip or repeat a local date near midnight.
 */
function shiftHouseholdCalendarDate(from: Date, days: number): string {
  const [year, month, day] = householdLocalDate(from).split("-").map(Number);
  if (year == null || month == null || day == null) {
    throw new Error("Could not resolve household calendar date");
  }
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}
