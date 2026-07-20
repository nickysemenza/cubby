/**
 * Day-index date math for the Gantt chart, over plain "YYYY-MM-DD" strings.
 *
 * CRITICAL: never construct `new Date(isoString)` from one of these plain
 * dates — that parses as UTC midnight and then renders in the *local*
 * timezone, which is the classic hydration/off-by-one-day trap (see
 * docs/todos.md's build-date hydration note). Every helper here goes through
 * `Date.UTC(y, m - 1, d)` and only ever reads back with the UTC getters, so a
 * "day index" is a pure integer (days since the Unix epoch) with no
 * timezone attached. The one deliberate exception is `todayPlain`, which
 * intentionally reads the *local* wall-clock date (what day it is for the
 * user right now) — that's the only place local getters belong.
 */

const MS_PER_DAY = 86_400_000;

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Month/quarter tick granularity switches at this span (in days). */
export const MONTH_TICK_MAX_SPAN_DAYS = 550;
/** Quarter/year tick granularity switches at this span (in days). */
export const QUARTER_TICK_MAX_SPAN_DAYS = 1600;
/** Weekend shading is only rendered below this span (in days). */
export const WEEKEND_BAND_MAX_SPAN_DAYS = 120;

export interface GanttTick {
  day: number;
  label: string;
  /** True for a tick that also marks a year boundary (Jan / Q1). */
  major?: boolean;
}

export interface GanttBand {
  startDay: number;
  endDay: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatPlain(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parsePlainDate(plain: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(plain);
  if (!match) {
    throw new Error(`Invalid plain date: ${plain}`);
  }
  const [, yStr, mStr, dStr] = match;
  if (yStr == null || mStr == null || dStr == null) {
    throw new Error(`Invalid plain date: ${plain}`);
  }
  return { y: Number(yStr), m: Number(mStr), d: Number(dStr) };
}

function dayIndexOf(y: number, m0: number, d: number): number {
  return Math.floor(Date.UTC(y, m0, d) / MS_PER_DAY);
}

function utcPartsFromDayIndex(day: number): {
  y: number;
  m0: number;
  d: number;
} {
  const date = new Date(day * MS_PER_DAY);
  return {
    y: date.getUTCFullYear(),
    m0: date.getUTCMonth(),
    d: date.getUTCDate(),
  };
}

/** Days since the Unix epoch (UTC), for a plain "YYYY-MM-DD" string. */
export function toDayIndex(plain: string): number {
  const { y, m, d } = parsePlainDate(plain);
  return dayIndexOf(y, m - 1, d);
}

/** Inverse of `toDayIndex` — back to a plain "YYYY-MM-DD" string. */
export function fromDayIndex(day: number): string {
  const { y, m0, d } = utcPartsFromDayIndex(day);
  return formatPlain(y, m0 + 1, d);
}

/**
 * Today's date, rendered in the *local* timezone as "YYYY-MM-DD" — the one
 * place in this module that intentionally reads local (not UTC) getters,
 * since "what day is it" is inherently a local-wall-clock question.
 */
export function todayPlain(): string {
  const now = new Date();
  return formatPlain(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** `toDayIndex(b) - toDayIndex(a)`, i.e. how many days after `a` is `b`. */
export function diffDays(a: string, b: string): number {
  return toDayIndex(b) - toDayIndex(a);
}

function twoDigitYear(y: number): string {
  return String(y % 100).padStart(2, "0");
}

function monthLabel(y: number, m0: number): string {
  const name = MONTH_SHORT[m0];
  if (name == null) {
    throw new Error(`unreachable: month index ${m0} out of range`);
  }
  return `${name} '${twoDigitYear(y)}`;
}

function buildMonthTicks(startDay: number, endDay: number): GanttTick[] {
  const ticks: GanttTick[] = [];
  const { y: startY, m0: startM } = utcPartsFromDayIndex(startDay);
  let y = startY;
  let m0 = startM;
  for (;;) {
    const day = dayIndexOf(y, m0, 1);
    if (day > endDay) break;
    ticks.push({ day, label: monthLabel(y, m0), major: m0 === 0 });
    m0 += 1;
    if (m0 > 11) {
      m0 = 0;
      y += 1;
    }
  }
  return ticks;
}

function buildQuarterTicks(startDay: number, endDay: number): GanttTick[] {
  const ticks: GanttTick[] = [];
  const { y: startY, m0: startM } = utcPartsFromDayIndex(startDay);
  let y = startY;
  let qm0 = Math.floor(startM / 3) * 3;
  for (;;) {
    const day = dayIndexOf(y, qm0, 1);
    if (day > endDay) break;
    const quarter = qm0 / 3 + 1;
    ticks.push({
      day,
      label: `Q${quarter} '${twoDigitYear(y)}`,
      major: quarter === 1,
    });
    qm0 += 3;
    if (qm0 > 9) {
      qm0 = 0;
      y += 1;
    }
  }
  return ticks;
}

function buildYearTicks(startDay: number, endDay: number): GanttTick[] {
  const ticks: GanttTick[] = [];
  const { y: startY } = utcPartsFromDayIndex(startDay);
  let y = startY;
  for (;;) {
    const day = dayIndexOf(y, 0, 1);
    if (day > endDay) break;
    ticks.push({ day, label: `${y}` });
    y += 1;
  }
  return ticks;
}

/**
 * Axis ticks for `[startDay, endDay]`, with granularity chosen by window
 * size: months for a short window, quarters for a medium one, years for a
 * long one. `major` marks a year boundary (Jan / Q1) within month/quarter
 * ticks so the renderer can draw a stronger gridline there.
 */
export function buildTicks(startDay: number, endDay: number): GanttTick[] {
  const span = endDay - startDay;
  if (span <= MONTH_TICK_MAX_SPAN_DAYS)
    return buildMonthTicks(startDay, endDay);
  if (span <= QUARTER_TICK_MAX_SPAN_DAYS)
    return buildQuarterTicks(startDay, endDay);
  return buildYearTicks(startDay, endDay);
}

function dayOfWeek(day: number): number {
  // Epoch day 0 (1970-01-01) was a Thursday, i.e. `new Date(0).getUTCDay() === 4`.
  // `%` in JS is remainder (not modulo), so shift by a multiple of 7 before
  // taking the remainder to stay non-negative for days before the epoch.
  return ((day % 7) + 7 + 4) % 7; // 0 = Sunday ... 6 = Saturday
}

/**
 * Saturday+Sunday bands to shade as weekends — only for a short-enough
 * window (beyond `WEEKEND_BAND_MAX_SPAN_DAYS` the shading is too dense to be
 * useful and the caller should skip it entirely).
 */
export function weekendBands(startDay: number, endDay: number): GanttBand[] {
  if (endDay - startDay > WEEKEND_BAND_MAX_SPAN_DAYS) return [];
  const bands: GanttBand[] = [];
  let d = startDay;
  while (d <= endDay) {
    const dow = dayOfWeek(d);
    if (dow === 6) {
      const hasSunday = d + 1 <= endDay && dayOfWeek(d + 1) === 0;
      bands.push({ startDay: d, endDay: hasSunday ? d + 1 : d });
      d += hasSunday ? 2 : 1;
    } else if (dow === 0) {
      // A lone Sunday at the very start of the window, with its Saturday
      // outside the range — still a (partial) weekend band.
      bands.push({ startDay: d, endDay: d });
      d += 1;
    } else {
      d += 1;
    }
  }
  return bands;
}
