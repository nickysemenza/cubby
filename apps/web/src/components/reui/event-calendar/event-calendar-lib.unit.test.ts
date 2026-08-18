import { addDays } from "date-fns";
import { describe, expect, it } from "vitest";
import { buildEventIndex, packWeekRowLanes } from "./event-calendar-lib";
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
