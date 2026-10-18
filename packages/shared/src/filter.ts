/**
 * A requested exact-entity filter whose URL value was not a valid shortcode.
 *
 * This must remain distinct from omission: omitted filters are unrestricted,
 * while this value resolves to an empty id set and therefore matches nothing.
 * It is not a valid shortcode and cannot collide with a real entity.
 */
export const UNRESOLVABLE_ENTITY_FILTER =
  "__unresolvable_entity_filter__" as const;

/**
 * The signed-in member, as a value of any Ledger Party filter.
 *
 * Saved views, URLs, and native filter state carry the token itself so one
 * declaration means "me" for every member; the entity kernel replaces it with
 * the actor's member shortcode before a repository runs, or with
 * `UNRESOLVABLE_ENTITY_FILTER` when the actor has no linked member, so an
 * unlinked actor matches nothing instead of losing the filter.
 */
export const CURRENT_MEMBER_FILTER = "@me" as const;

/** Owner filter states beside people: stock deliberately owned by nobody, and
 * stock whose inheritance names nobody unambiguously. */
export const OWNER_FILTER_HOUSEHOLD = "@household" as const;
export const OWNER_FILTER_UNKNOWN = "@unknown" as const;

/**
 * The household's current day, as a date range bound (#2415). `@today`,
 * `@today-30d`, and `@today+7d` are values like `@me`: saved views, URLs,
 * MCP, and native filter state carry the token, and the entity kernel
 * resolves it to the household-local date at query time, so a saved view
 * stays current without editing.
 */
export const RELATIVE_DATE_TODAY = "@today" as const;

export const RELATIVE_DATE_PATTERN = /^@today(?:([+-])(\d{1,5})d)?$/;

/** A relative date token's whole-day offset from today, or undefined for any other value. */
export const relativeDateOffset = (value: string): number | undefined => {
  const match = RELATIVE_DATE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, sign, days] = match;
  if (days === undefined) return 0;
  return sign === "-" ? -Number(days) : Number(days);
};

/** The token `days` whole days from today (negative is the past). */
export const relativeDateToken = (days: number): string =>
  days === 0
    ? RELATIVE_DATE_TODAY
    : `${RELATIVE_DATE_TODAY}${days < 0 ? "-" : "+"}${Math.abs(days)}d`;

/**
 * A date bound with any token resolved against `today` (a household-local
 * "YYYY-MM-DD"); any other value is returned as is. Day arithmetic runs on
 * the calendar date, so it never crosses a timezone or DST boundary.
 */
export const resolveRelativeDate = (value: string, today: string): string => {
  const days = relativeDateOffset(value);
  if (days === undefined) return value;
  const [year, month, day] = today.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    throw new RangeError(`Invalid plain date: ${today}`);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
};

/** "today", "today − 30 days", "today + 1 day": how a client shows a token. */
export const describeRelativeDate = (days: number): string => {
  if (days === 0) return "today";
  const count = Math.abs(days);
  return `today ${days < 0 ? "−" : "+"} ${count} ${count === 1 ? "day" : "days"}`;
};

/**
 * A date range filter's bounds as one URL or saved-view value, `from..to`,
 * either side empty when unbounded and each a "YYYY-MM-DD" date or a
 * relative date token: `..@today-1d` is "before today". A range filter's
 * other values are preset keys, which never contain the separator.
 */
export const RANGE_BOUNDS_SEPARATOR = ".." as const;

export const parseRangeBounds = (
  value: string,
): { from: string | undefined; to: string | undefined } | undefined => {
  const at = value.indexOf(RANGE_BOUNDS_SEPARATOR);
  if (at === -1) return undefined;
  const from = value.slice(0, at).trim();
  const to = value.slice(at + RANGE_BOUNDS_SEPARATOR.length).trim();
  if (!from && !to) return undefined;
  return { from: from || undefined, to: to || undefined };
};

export const formatRangeBounds = (
  from: string | undefined,
  to: string | undefined,
): string | undefined =>
  from || to ? `${from ?? ""}${RANGE_BOUNDS_SEPARATOR}${to ?? ""}` : undefined;

/** A date bound as a client shows it: a token as "today − 30 days", a date as is. */
export const describeDateBound = (bound: string): string => {
  const days = relativeDateOffset(bound);
  return days === undefined ? bound : describeRelativeDate(days);
};

/**
 * A `from..to` bounds value as a chip reads it ("on or before today − 1
 * day"), or undefined when the value is not bounds (a preset key).
 */
export const describeRangeBounds = (value: string): string | undefined => {
  const bounds = parseRangeBounds(value);
  if (bounds === undefined) return undefined;
  const { from, to } = bounds;
  if (from && to)
    return `${describeDateBound(from)} to ${describeDateBound(to)}`;
  if (from) return `on or after ${describeDateBound(from)}`;
  return to ? `on or before ${describeDateBound(to)}` : undefined;
};

/**
 * A number range filter as its declaration constrains it; its value is the
 * same `min..max` bounds a date range uses, each side a plain number.
 */
export type NumberRange = Readonly<{
  nonnegative?: boolean;
  int?: boolean;
  describe?: Readonly<{ lower: string; upper: string }>;
}>;

// A decimal never ends in `.`: `1.` before the `..` separator would read
// as `1` and `.`. An exponent is accepted because a number input yields one.
const NUMBER_BOUND_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * One typed number bound, or undefined when it is not a finite decimal the
 * declaration accepts (negative under `nonnegative`, fractional or beyond
 * exact integers under `int`).
 */
export const parseNumberBound = (
  text: string,
  range: NumberRange,
): number | undefined => {
  const trimmed = text.trim();
  if (!NUMBER_BOUND_PATTERN.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (range.nonnegative && value < 0) return undefined;
  if (range.int && !Number.isSafeInteger(value)) return undefined;
  return value;
};

/**
 * A number bound as its URL text: the shortest digits that read back as the
 * same number, never in exponent form (`1e-7` is written `0.0000001`).
 */
export const formatNumberBound = (value: number): string => {
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign = "", lead = "", rest = "", exponent = "0"] = match;
  const digits = lead + rest;
  const point = 1 + Number(exponent);
  // `String` switches to exponent form only below 1e-6 or from 1e21, where
  // the point sits before the digits or past them.
  return point <= 0
    ? `${sign}0.${"0".repeat(-point)}${digits}`
    : `${sign}${digits.padEnd(point, "0")}`;
};

/** A number range's `min..max` value with each invalid side dropped. */
export const parseNumberRangeBounds = (
  value: string,
  range: NumberRange,
): { min: number | undefined; max: number | undefined } | undefined => {
  const bounds = parseRangeBounds(value);
  if (bounds === undefined) return undefined;
  const min =
    bounds.from === undefined
      ? undefined
      : parseNumberBound(bounds.from, range);
  const max =
    bounds.to === undefined ? undefined : parseNumberBound(bounds.to, range);
  return min === undefined && max === undefined ? undefined : { min, max };
};

/** A number range's bounds as a chip reads them ("at least 2", "1 to 48"). */
export const describeNumberRangeBounds = (
  value: string,
  range: NumberRange,
): string | undefined => {
  const bounds = parseNumberRangeBounds(value, range);
  if (bounds === undefined) return undefined;
  const { min, max } = bounds;
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  return min === undefined ? `at most ${max}` : `at least ${min}`;
};
