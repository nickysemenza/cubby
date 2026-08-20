import { addDays } from "date-fns";
import { describe, expect, it } from "vitest";
import {
  buildEventIndex,
  buildWeekLedger,
  getDayKey,
  getViewDateRange,
  packWeekRowLanes,
  stepDate,
} from "./event-calendar-lib";
import type {
  CalendarEvent,
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "./event-calendar-types";

const occurrence = (
  id: string,
  start: Date,
  end: Date,
): EventCalendarOccurrence => {
  const event: CalendarEvent = {
    id,
    title: id,
    start,
    end,
    allDay: true,
  };
  return {
    key: `${id}::${start.toISOString()}`,
    eventId: id,
    event,
    start,
    end,
    allDay: true,
  };
};

const segment = (
  value: EventCalendarOccurrence,
  day: Date,
  isStart: boolean,
  isEnd: boolean,
): EventCalendarSegment => ({
  occurrence: value,
  day,
  isStart,
  isEnd,
  continuesBefore: !isStart,
  continuesAfter: !isEnd,
});

describe("ReUI month span packing", () => {
  it("merges a multi-day project bar and moves overlaps to another lane", () => {
    const rowStart = new Date("2026-07-05T00:00:00.000Z");
    const project = occurrence(
      "project",
      addDays(rowStart, 1),
      addDays(rowStart, 4),
    );
    const overlap = occurrence(
      "task-range",
      addDays(rowStart, 2),
      addDays(rowStart, 3),
    );
    const later = occurrence(
      "expense",
      addDays(rowStart, 5),
      addDays(rowStart, 6),
    );

    const bars = packWeekRowLanes(
      [
        segment(project, addDays(rowStart, 1), true, false),
        segment(project, addDays(rowStart, 2), false, false),
        segment(project, addDays(rowStart, 3), false, true),
        segment(overlap, addDays(rowStart, 2), true, true),
        segment(later, addDays(rowStart, 5), true, true),
      ],
      0,
      rowStart,
      "UTC",
    );

    expect(bars).toHaveLength(3);
    expect(bars.find((bar) => bar.occurrence.eventId === "project")).toMatchObject(
      {
        colStart: 1,
        colSpan: 3,
        lane: 0,
        isStart: true,
        isEnd: true,
      },
    );
    expect(
      bars.find((bar) => bar.occurrence.eventId === "task-range")?.lane,
    ).toBe(1);
    expect(
      bars.find((bar) => bar.occurrence.eventId === "expense")?.lane,
    ).toBe(0);
  });
});

describe("buildEventIndex month boundaries", () => {
  const range = {
    start: new Date("2026-03-01T08:00:00.000Z"),
    end: new Date("2026-04-01T07:00:00.000Z"),
  };
  const index = (events: CalendarEvent[]) =>
    buildEventIndex(events, range, {
      timeZone: "America/Los_Angeles",
      weekStartsOn: 0,
    });

  it("keeps point events inside the range and excludes points at its end", () => {
    expect(
      index([
        { id: "inside", title: "inside", start: range.start, end: range.start },
        { id: "end", title: "end", start: range.end, end: range.end },
      ]).occurrences.map((item) => item.eventId),
    ).toEqual(["inside"]);
  });

  it("includes only spans that intersect the exclusive range", () => {
    expect(
      index([
        { id: "before", title: "before", start: new Date("2026-02-27T08:00:00Z"), end: range.start },
        { id: "cross", title: "cross", start: new Date("2026-02-28T08:00:00Z"), end: new Date("2026-03-02T08:00:00Z") },
        { id: "after", title: "after", start: range.end, end: new Date("2026-04-02T07:00:00Z") },
      ]).occurrences.map((item) => item.eventId),
    ).toEqual(["cross"]);
  });

  it("places a DST-crossing span in each Pacific calendar day", () => {
    const result = index([
      {
        id: "dst",
        title: "DST",
        start: new Date("2026-03-07T08:00:00.000Z"),
        end: new Date("2026-03-10T07:00:00.000Z"),
        allDay: true,
      },
    ]);
    expect(
      [...result.byDay.entries()]
        .filter(([, bucket]) => bucket.allDay.some((segment) => segment.occurrence.eventId === "dst"))
        .map(([day]) => day),
    ).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });
});

describe("weekly calendar ranges", () => {
  const options = {
    timeZone: "America/Los_Angeles",
    weekStartsOn: 0 as const,
    fixedWeeks: true,
  };

  it("uses an exclusive Sunday boundary across spring-forward", () => {
    const { activeRange, visibleRange } = getViewDateRange(
      "week",
      new Date("2026-03-11T19:00:00.000Z"),
      options,
    );

    expect(getDayKey(activeRange.start, options.timeZone)).toBe("2026-03-08");
    expect(getDayKey(activeRange.end, options.timeZone)).toBe("2026-03-15");
    expect(activeRange).toEqual(visibleRange);
    expect(activeRange.end.getTime() - activeRange.start.getTime()).toBe(
      167 * 60 * 60_000,
    );
  });

  it("steps by one local week across year and fall-back boundaries", () => {
    const fall = stepDate(
      "week",
      new Date("2026-10-29T19:00:00.000Z"),
      1,
      options,
    );
    const year = stepDate(
      "week",
      new Date("2026-12-30T20:00:00.000Z"),
      1,
      options,
    );

    expect(getDayKey(fall, options.timeZone)).toBe("2026-11-05");
    expect(getDayKey(year, options.timeZone)).toBe("2027-01-06");
  });
});

describe("buildWeekLedger", () => {
  const start = new Date("2026-07-05T07:00:00.000Z");
  const end = new Date("2026-07-12T07:00:00.000Z");
  const event = (
    id: string,
    startOffset: number,
    endOffset: number,
  ): CalendarEvent => ({
    id,
    title: id,
    start: addDays(start, startOffset),
    end: addDays(start, endOffset),
    allDay: true,
  });

  it("separates spans from single-day items and repacks only the spans", () => {
    const index = buildEventIndex(
      [
        event("single", 1, 2),
        event("project", 1, 4),
        event("task-range", 2, 5),
        event("point", 3, 3),
      ],
      { start, end },
      { timeZone: "America/Los_Angeles", weekStartsOn: 0 },
    );
    const ledger = buildWeekLedger(
      index,
      start,
      "America/Los_Angeles",
    );

    expect(ledger.spans.map((span) => span.occurrence.eventId)).toEqual([
      "project",
      "task-range",
    ]);
    expect(ledger.spans.map((span) => span.lane)).toEqual([0, 1]);
    expect(
      ledger.days.map((day) =>
        day.segments.map((segment) => segment.occurrence.eventId),
      ),
    ).toEqual([[], ["single"], [], ["point"], [], [], []]);
  });

  it("keeps a clipped cross-week occurrence in the span lanes", () => {
    const index = buildEventIndex(
      [event("crossing", -2, 2)],
      { start, end },
      { timeZone: "America/Los_Angeles", weekStartsOn: 0 },
    );
    const [span] = buildWeekLedger(
      index,
      start,
      "America/Los_Angeles",
    ).spans;

    expect(span).toMatchObject({
      colStart: 0,
      colSpan: 2,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("moves every full visible-week span into the compact shelf", () => {
    const index = buildEventIndex(
      [event("ongoing", -2, 9), event("partial", 1, 4)],
      { start, end },
      { timeZone: "America/Los_Angeles", weekStartsOn: 0 },
    );
    const ledger = buildWeekLedger(index, start, "America/Los_Angeles");

    expect(ledger.compactSpans.map((span) => span.occurrence.eventId)).toEqual([
      "ongoing",
    ]);
    expect(ledger.spans.map((span) => span.occurrence.eventId)).toEqual([
      "partial",
    ]);
  });
});
