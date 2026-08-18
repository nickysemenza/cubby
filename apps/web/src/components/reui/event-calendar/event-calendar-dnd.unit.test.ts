import { format } from "date-fns";
import { describe, expect, it } from "vitest";
import {
  type EventCalendarDragData,
  isEventCalendarKeyboardTarget,
  proposeEventCalendarDrop,
} from "./event-calendar-dnd";
import { toZoned } from "./event-calendar-lib";
import type {
  CalendarEvent,
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "./event-calendar-types";

const TIME_ZONE = "America/Los_Angeles";

function segment(
  start: string,
  end: string,
  day: string,
  allDay = false,
): EventCalendarSegment {
  const event: CalendarEvent = {
    id: "event",
    title: "Event",
    start: new Date(start),
    end: new Date(end),
    allDay,
    resourceId: "old-resource",
  };
  const occurrence: EventCalendarOccurrence = {
    key: `event::${start}`,
    eventId: event.id,
    event,
    start: event.start,
    end: event.end,
    allDay,
    isRecurring: false,
  };
  return {
    occurrence,
    day: new Date(day),
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
  };
}

function drag(
  value: EventCalendarSegment,
  kind: "move" | "resize-start" | "resize-end",
): EventCalendarDragData<unknown> {
  return { calendarGesture: true, kind, segment: value };
}

const local = (date: Date) =>
  format(toZoned(date, TIME_ZONE), "yyyy-MM-dd HH:mm");

describe("isEventCalendarKeyboardTarget", () => {
  it("skips the source cell so an arrow reaches the adjacent day", () => {
    const value = segment(
      "2026-07-14T07:00:00.000Z",
      "2026-07-15T07:00:00.000Z",
      "2026-07-14T07:00:00.000Z",
      true,
    );
    const active = drag(value, "move");

    expect(
      isEventCalendarKeyboardTarget(active, {
        calendarDrop: true,
        day: value.day,
        allDay: true,
      }),
    ).toBe(false);
    expect(
      isEventCalendarKeyboardTarget(active, {
        calendarDrop: true,
        day: new Date("2026-07-15T07:00:00.000Z"),
        allDay: true,
      }),
    ).toBe(true);
  });
});

describe("proposeEventCalendarDrop", () => {
  it("preserves local start time and exact duration across spring-forward", () => {
    const value = segment(
      "2026-03-08T22:00:00.000Z",
      "2026-03-08T23:00:00.000Z",
      "2026-03-08T08:00:00.000Z",
    );

    const update = proposeEventCalendarDrop(
      drag(value, "move"),
      {
        calendarDrop: true,
        day: new Date("2026-03-09T07:00:00.000Z"),
        allDay: false,
        resourceId: "new-resource",
      },
      TIME_ZONE,
    );

    expect(update).not.toBeNull();
    expect(local(update!.start)).toBe("2026-03-09 15:00");
    expect(update!.end.getTime() - update!.start.getTime()).toBe(60 * 60_000);
    expect(update!.resourceId).toBe("new-resource");
  });

  it("uses the grabbed segment day instead of re-anchoring a spanning bar", () => {
    const value = segment(
      "2026-03-07T08:00:00.000Z",
      "2026-03-10T07:00:00.000Z",
      "2026-03-08T08:00:00.000Z",
      true,
    );

    const update = proposeEventCalendarDrop(
      drag(value, "move"),
      {
        calendarDrop: true,
        day: new Date("2026-03-11T07:00:00.000Z"),
        allDay: true,
      },
      TIME_ZONE,
    );

    expect(local(update!.start)).toBe("2026-03-10 00:00");
  });

  it("keeps a cross-midnight resize end on the pointed day", () => {
    const value = segment(
      "2026-08-02T06:30:00.000Z",
      "2026-08-02T07:30:00.000Z",
      "2026-08-02T07:00:00.000Z",
    );

    const update = proposeEventCalendarDrop(
      drag(value, "resize-end"),
      {
        calendarDrop: true,
        day: new Date("2026-08-03T07:00:00.000Z"),
        allDay: false,
      },
      TIME_ZONE,
    );

    expect(local(update!.end)).toBe("2026-08-03 00:30");
  });

  it("rejects a resize that would invert the occurrence", () => {
    const value = segment(
      "2026-08-02T16:00:00.000Z",
      "2026-08-02T17:00:00.000Z",
      "2026-08-02T07:00:00.000Z",
    );

    expect(
      proposeEventCalendarDrop(
        drag(value, "resize-start"),
        {
          calendarDrop: true,
          day: new Date("2026-08-03T07:00:00.000Z"),
          allDay: false,
        },
        TIME_ZONE,
      ),
    ).toBeNull();
  });
});
