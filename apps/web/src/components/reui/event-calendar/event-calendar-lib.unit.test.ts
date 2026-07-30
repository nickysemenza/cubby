import { addDays } from "date-fns";
import { describe, expect, it } from "vitest";
import { packWeekRowLanes } from "./event-calendar-lib";
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
    isRecurring: false,
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
