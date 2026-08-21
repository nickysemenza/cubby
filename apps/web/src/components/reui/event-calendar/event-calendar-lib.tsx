import { TZDate } from "@date-fns/tz";
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type {
  CalendarEvent,
  CalendarPeriod,
  EventCalendarDateRange,
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "~/components/reui/event-calendar/event-calendar-types";

type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;


/** The instant re-expressed in the display time zone (TZDate extends Date). */
function toZoned(date: Date, timeZone: string): TZDate {
  return new TZDate(date.getTime(), timeZone);
}

/** Zoned midnight of the day containing the instant. */
function zonedStartOfDay(date: Date, timeZone: string): TZDate {
  return startOfDay(toZoned(date, timeZone));
}

/** Stable per-day key in the display time zone. */
function getDayKey(date: Date, timeZone: string): string {
  return format(toZoned(date, timeZone), "yyyy-MM-dd");
}

interface ViewRangeOptions {
  timeZone: string;
  weekStartsOn: WeekStartsOn;
  fixedWeeks: boolean;
}

interface ViewDateRanges {
  visibleRange: EventCalendarDateRange;
  activeRange: EventCalendarDateRange;
}

function getViewDateRange(
  period: CalendarPeriod,
  date: Date,
  opts: ViewRangeOptions,
): ViewDateRanges {
  const { timeZone, weekStartsOn, fixedWeeks } = opts;
  const zoned = toZoned(date, timeZone);

  if (period === "week" || period === "fortnight") {
    const start = startOfWeek(zoned, { weekStartsOn });
    const end = addWeeks(start, period === "fortnight" ? 2 : 1);
    // Active === visible: every day in a week/fortnight belongs to the period,
    // so no cell is `outside` and `fixedWeeks` never applies.
    return {
      activeRange: { start, end },
      visibleRange: { start, end },
    };
  }

  const activeStart = startOfMonth(zoned);
  const activeEnd = startOfMonth(addMonths(zoned, 1));
  const visibleStart = startOfWeek(activeStart, { weekStartsOn });
  const visibleEnd = fixedWeeks
    ? addDays(visibleStart, 42)
    : addWeeks(startOfWeek(addDays(activeEnd, -1), { weekStartsOn }), 1);
  return {
    activeRange: { start: activeStart, end: activeEnd },
    visibleRange: { start: visibleStart, end: visibleEnd },
  };
}

/** Day of month of the last day of the month containing the zoned date. */
function lastDayOfZonedMonth(date: Date): number {
  return addDays(startOfMonth(addMonths(date, 1)), -1).getDate();
}

/** The anchor date stepped one period forward or backward for the view. */
function stepDate(
  period: CalendarPeriod,
  date: Date,
  direction: 1 | -1,
  opts: Pick<ViewRangeOptions, "timeZone">,
): Date {
  const zoned = toZoned(date, opts.timeZone);
  if (period === "week") return addWeeks(zoned, direction);
  if (period === "fortnight") return addWeeks(zoned, direction * 2);
  const stepped = addMonths(zoned, direction);
  // addMonths clamps the day down into a shorter month and never restores
  // it, so next-then-prev from the 31st would leave the anchor on the 28th.
  if (zoned.getDate() !== lastDayOfZonedMonth(zoned)) return stepped;
  return addDays(stepped, lastDayOfZonedMonth(stepped) - stepped.getDate());
}

function rangesIntersect(
  a: EventCalendarDateRange,
  b: EventCalendarDateRange,
): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * The one canonical multi-day segmentation. Splits an occurrence into per-day
 * segments clamped to the range. Rules (unit-tested in M1): exclusive end - an
 * event ending exactly at zoned midnight emits NO segment for that day;
 * zero-duration events emit one min-height segment; allDay occurrences walk
 * the same absolute instants as timed ones and only drop startMin/endMin, so
 * their bounds have to already BE display-zone midnights (see
 * CalendarEvent.allDay) or the bar paints on the wrong days.
 */
function segmentOccurrence<TData>(
  occurrence: EventCalendarOccurrence<TData>,
  range: EventCalendarDateRange,
  timeZone: string,
): EventCalendarSegment<TData>[] {
  const occStart = occurrence.start;
  const occEnd = occurrence.end;
  const isZeroLength = occEnd.getTime() === occStart.getTime();

  const clampStart = occStart > range.start ? occStart : range.start;
  const clampEnd = occEnd < range.end ? occEnd : range.end;
  if (clampEnd < clampStart) return [];
  if (clampEnd.getTime() === clampStart.getTime() && !isZeroLength) return [];

  const segments: EventCalendarSegment<TData>[] = [];
  let cursor = zonedStartOfDay(clampStart, timeZone);

  while (cursor < clampEnd || (isZeroLength && segments.length === 0)) {
    const next = zonedStartOfDay(
      addDays(toZoned(cursor, timeZone), 1),
      timeZone,
    );
    const segStart = clampStart > cursor ? clampStart : cursor;
    const segEnd = clampEnd < next ? clampEnd : next;

    const emptySeg = segEnd.getTime() <= segStart.getTime();
    if (!emptySeg || isZeroLength) {
      const isStart = segStart.getTime() === occStart.getTime();
      const isEnd = segEnd.getTime() === occEnd.getTime();
      segments.push({
        occurrence,
        day: cursor,
        isStart,
        isEnd,
        continuesBefore: !isStart,
        continuesAfter: !isEnd,
      });
    }
    if (isZeroLength) break;
    cursor = next;
  }

  return segments;
}

/** True when the occurrence should render as a bar (all-day row / month lanes). */
function isBarOccurrence(
  occurrence: EventCalendarOccurrence,
  timeZone?: string,
): boolean {
  return occurrence.allDay || spansMultipleDays(occurrence, timeZone);
}

function spansMultipleDays(
  occ: { start: Date; end: Date },
  timeZone?: string,
): boolean {
  // An event ending exactly at the next midnight is still single-day
  // (exclusive end), so compare against a strictly-later instant. The
  // yardstick is the length of the day the event starts on, never a flat 24h:
  // a fall-back day is 25h long, and a 00:00-to-00:00 shift on it is still one
  // calendar day that belongs in the hour track, not in the all-day row.
  // Without a display zone the dates answer in their own frame (TZDate) or in
  // the host zone.
  const dayStart = startOfDay(
    timeZone ? toZoned(occ.start, timeZone) : occ.start,
  );
  const nextDayStart = startOfDay(addDays(dayStart, 1));
  return (
    occ.end.getTime() - occ.start.getTime() >
    nextDayStart.getTime() - dayStart.getTime()
  );
}

/**
 * Build the laned month-row bars for one week: consecutive-day segments of
 * the same occurrence merge into ONE bar (colStart -> colSpan) stacked into
 * lanes. Returns NEW segment objects - the shared per-day segments (also
 * rendered by the all-day rows and day cells) must stay pristine: mutating
 * their isEnd/continues flags gave the first-day chip a whole-bar shape and
 * a bogus end resize handle in the week all-day row, where dragging it
 * collapsed the event to a single day.
 */
function packWeekRowLanes<TData>(
  segments: EventCalendarSegment<TData>[],
  rowIndex: number,
  rowStart: Date,
  timeZone: string,
): EventCalendarSegment<TData>[] {
  type Bar = {
    seg: EventCalendarSegment<TData>;
    colStart: number;
    colSpan: number;
    isStart: boolean;
    isEnd: boolean;
    lane: number;
  };

  const bars: Bar[] = segments.map((seg) => {
    const dayIndex = Math.round(
      (zonedStartOfDay(seg.day, timeZone).getTime() -
        zonedStartOfDay(rowStart, timeZone).getTime()) /
        (24 * 60 * 60 * 1000),
    );
    return {
      seg,
      colStart: Math.max(0, Math.min(6, dayIndex)),
      colSpan: 1,
      isStart: seg.isStart,
      isEnd: seg.isEnd,
      lane: 0,
    };
  });

  // Merge consecutive-day segments of the same occurrence into one bar per row
  const merged = new Map<string, Bar>();
  for (const bar of bars) {
    const key = bar.seg.occurrence.key;
    const existing = merged.get(key);
    if (existing) {
      const start = Math.min(existing.colStart, bar.colStart);
      const end = Math.max(
        existing.colStart + existing.colSpan,
        bar.colStart + bar.colSpan,
      );
      existing.colStart = start;
      existing.colSpan = end - start;
      existing.isStart = existing.isStart || bar.isStart;
      existing.isEnd = existing.isEnd || bar.isEnd;
    } else {
      merged.set(key, bar);
    }
  }

  const rowBars = Array.from(merged.values()).sort(
    (a, b) =>
      a.colStart - b.colStart ||
      b.colSpan - a.colSpan ||
      a.seg.occurrence.key.localeCompare(b.seg.occurrence.key),
  );

  const lanes: boolean[][] = [];
  for (const bar of rowBars) {
    let lane = 0;
    for (;;) {
      lanes[lane] ??= new Array(7).fill(false);
      const row = (lanes[lane] ??= new Array(7).fill(false));
      let free = true;
      for (let c = bar.colStart; c < bar.colStart + bar.colSpan; c++) {
        if (row[c]) {
          free = false;
          break;
        }
      }
      if (free) break;
      lane++;
    }
    for (let c = bar.colStart; c < bar.colStart + bar.colSpan; c++) {
      lanes[lane]![c] = true;
    }
    bar.lane = lane;
  }

  return rowBars.map((bar) => ({
    ...bar.seg,
    isStart: bar.isStart,
    isEnd: bar.isEnd,
    continuesBefore: !bar.isStart,
    continuesAfter: !bar.isEnd,
    lane: bar.lane,
    rowIndex,
    colStart: bar.colStart,
    colSpan: bar.colSpan,
  }));
}

/** Re-pack already merged week bars after a renderer filters their membership. */
function repackWeekBars<TData>(
  bars: readonly EventCalendarSegment<TData>[],
): EventCalendarSegment<TData>[] {
  const placed = [...bars]
    .sort(
      (a, b) =>
        (a.colStart ?? 0) - (b.colStart ?? 0) ||
        (b.colSpan ?? 1) - (a.colSpan ?? 1) ||
        a.occurrence.key.localeCompare(b.occurrence.key),
    )
    .map((bar) => ({ ...bar, lane: 0 }));
  const lanes: boolean[][] = [];

  for (const bar of placed) {
    const start = bar.colStart ?? 0;
    const end = start + (bar.colSpan ?? 1);
    let lane = 0;
    for (;;) {
      const row = (lanes[lane] ??= new Array(7).fill(false));
      if (row.slice(start, end).every((occupied) => !occupied)) break;
      lane += 1;
    }
    const row = lanes[lane]!;
    for (let column = start; column < end; column += 1) row[column] = true;
    bar.lane = lane;
  }

  return placed;
}

function occurrenceSpansCalendarDays(
  occurrence: EventCalendarOccurrence,
  timeZone: string,
): boolean {
  if (occurrence.end <= occurrence.start) return false;
  const finalCoveredInstant = new Date(occurrence.end.getTime() - 1);
  return (
    differenceInCalendarDays(
      toZoned(finalCoveredInstant, timeZone),
      toZoned(occurrence.start, timeZone),
    ) > 0
  );
}

interface EventCalendarDayBucket<TData = unknown> {
  allDay: EventCalendarSegment<TData>[];
  timed: EventCalendarSegment<TData>[];
}

interface EventCalendarWeekRow<TData = unknown> {
  rowIndex: number;
  rowStart: Date;
  /** Laned bar segments (one per occurrence per row). */
  bars: EventCalendarSegment<TData>[];
}

interface EventCalendarIndex<TData = unknown> {
  occurrences: EventCalendarOccurrence<TData>[];
  byDay: Map<string, EventCalendarDayBucket<TData>>;
  weekRows: EventCalendarWeekRow<TData>[];
}

interface EventCalendarWeekLedgerDay<TData = unknown> {
  day: Date;
  segments: EventCalendarSegment<TData>[];
}

interface EventCalendarWeekLedger<TData = unknown> {
  /**
   * Occurrences covering every visible day in the week. These live in a
   * wrapping shelf rather than consuming a seven-column timeline lane.
   */
  compactSpans: EventCalendarSegment<TData>[];
  /** Spans that still communicate their partial-week dates through alignment. */
  spans: EventCalendarSegment<TData>[];
  days: EventCalendarWeekLedgerDay<TData>[];
}

/** A full visible week has no date alignment left to communicate. */
function occupiesFullWeek(segment: EventCalendarSegment): boolean {
  return segment.colStart === 0 && segment.colSpan === 7;
}

/**
 * Project one indexed week into the focused ledger: multi-day occurrences are
 * continuous top lanes, while single-day occurrences appear exactly once in
 * their day column. Filtering happens before re-packing so single-day items do
 * not leave phantom gaps in the span lanes.
 */
function buildWeekLedger<TData>(
  index: EventCalendarIndex<TData>,
  rowStart: Date,
  timeZone: string,
): EventCalendarWeekLedger<TData> {
  const normalizedStart = zonedStartOfDay(rowStart, timeZone);
  const row = index.weekRows.find(
    (candidate) =>
      zonedStartOfDay(candidate.rowStart, timeZone).getTime() ===
      normalizedStart.getTime(),
  );
  const spanningKeys = new Set(
    index.occurrences
      .filter((occurrence) => occurrenceSpansCalendarDays(occurrence, timeZone))
      .map((occurrence) => occurrence.key),
  );
  const weekBars = (row?.bars ?? []).filter((bar) =>
    spanningKeys.has(bar.occurrence.key),
  );
  // Only fully week-wide bars trade the date grid for a compact, wrapping
  // shelf. A partial span's alignment is still meaningful planning data, so
  // it remains in the seven-column timeline below.
  const compactSpans = weekBars.filter(occupiesFullWeek);
  const spans = repackWeekBars(
    weekBars.filter((bar) => !occupiesFullWeek(bar)),
  );
  const days = Array.from({ length: 7 }, (_, offset) => {
    const day = zonedStartOfDay(
      addDays(toZoned(normalizedStart, timeZone), offset),
      timeZone,
    );
    const bucket = index.byDay.get(getDayKey(day, timeZone));
    const segments = bucket
      ? [...bucket.allDay, ...bucket.timed].filter(
          (segment) => !spanningKeys.has(segment.occurrence.key),
        )
      : [];
    return { day, segments };
  });
  return { compactSpans, spans, days };
}

interface BuildIndexOptions<TData> {
  timeZone: string;
  weekStartsOn: WeekStartsOn;
  eventOrder?: (
    a: EventCalendarOccurrence<TData>,
    b: EventCalendarOccurrence<TData>,
  ) => number;
}

function defaultEventOrder(
  a: EventCalendarOccurrence,
  b: EventCalendarOccurrence,
): number {
  return (
    a.start.getTime() - b.start.getTime() ||
    b.end.getTime() -
      b.start.getTime() -
      (a.end.getTime() - a.start.getTime()) ||
    a.key.localeCompare(b.key)
  );
}

function buildEventIndex<TData>(
  events: CalendarEvent<TData>[],
  visibleRange: EventCalendarDateRange,
  opts: BuildIndexOptions<TData>,
): EventCalendarIndex<TData> {
  const { timeZone, weekStartsOn } = opts;
  const order = opts.eventOrder ?? defaultEventOrder;

  const occurrences: EventCalendarOccurrence<TData>[] = [];
  for (const event of events) {
    const isPoint = event.end.getTime() === event.start.getTime();
    if (
      !rangesIntersect({ start: event.start, end: event.end }, visibleRange) &&
      !(isPoint && event.start >= visibleRange.start && event.start < visibleRange.end)
    ) continue;
    occurrences.push({
      key: `${event.id}::${event.start.toISOString()}`,
      eventId: event.id,
      event,
      start: event.start,
      end: event.end,
      allDay: event.allDay ?? false,
    });
  }
  occurrences.sort(order);

  const byDay = new Map<string, EventCalendarDayBucket<TData>>();
  const barSegmentsByRow = new Map<number, EventCalendarSegment<TData>[]>();
  const firstRowStart = startOfWeek(toZoned(visibleRange.start, timeZone), {
    weekStartsOn,
  });

  for (const occurrence of occurrences) {
    const segments = segmentOccurrence(occurrence, visibleRange, timeZone);
    const bar = isBarOccurrence(occurrence, timeZone);
    for (const seg of segments) {
      const key = getDayKey(seg.day, timeZone);
      let bucket = byDay.get(key);
      if (!bucket) {
        bucket = { allDay: [], timed: [] };
        byDay.set(key, bucket);
      }
      if (bar) {
        bucket.allDay.push(seg);
        // calendar-day math, not a fixed 168h divisor: DST transition weeks
        // are 167/169h long and the fixed divisor mis-buckets every later
        // Sunday one row early (which then clamps into the wrong column)
        const rowIndex = Math.floor(
          differenceInCalendarDays(toZoned(seg.day, timeZone), firstRowStart) /
            7,
        );
        const rowBucket = barSegmentsByRow.get(rowIndex) ?? [];
        rowBucket.push(seg);
        barSegmentsByRow.set(rowIndex, rowBucket);
      } else {
        bucket.timed.push(seg);
      }
    }
  }

  const weekRows: EventCalendarWeekRow<TData>[] = [];
  for (const [rowIndex, segs] of barSegmentsByRow) {
    const rowStart = addWeeks(firstRowStart, rowIndex);
    weekRows.push({
      rowIndex,
      rowStart,
      bars: packWeekRowLanes(segs, rowIndex, rowStart, timeZone),
    });
  }
  weekRows.sort((a, b) => a.rowIndex - b.rowIndex);

  return { occurrences, byDay, weekRows };
}

/** Cache key for index memoization; cheap string compare. */
function getRangeKey(range: EventCalendarDateRange): string {
  return `${range.start.getTime()}-${range.end.getTime()}`;
}


export type {
  EventCalendarDayBucket,
  EventCalendarIndex,
  WeekStartsOn,
};
export {
  buildWeekLedger,
  buildEventIndex,
  defaultEventOrder,
  getDayKey,
  getRangeKey,
  getViewDateRange,
  packWeekRowLanes,
  occupiesFullWeek,
  stepDate,
  toZoned,
  zonedStartOfDay,
};
