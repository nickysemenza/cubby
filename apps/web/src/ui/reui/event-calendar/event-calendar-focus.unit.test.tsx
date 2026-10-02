import { describe, expect, it } from "vitest";
import {
  captureEventCalendarChipFocus,
  restoreEventCalendarChipFocus,
} from "./event-calendar-focus";
import type {
  CalendarEvent,
  EventCalendarOccurrence,
  EventCalendarSegment,
} from "./event-calendar-types";

describe("event calendar focus restoration", () => {
  it("moves focus to the re-keyed chip after a calendar move", () => {
    const oldChip = document.createElement("button");
    document.body.append(oldChip);
    oldChip.focus();
    captureEventCalendarChipFocus(oldChip, "event");
    oldChip.remove();

    const root = document.createElement("div");
    const newChip = document.createElement("button");
    newChip.dataset.slot = "event-calendar-event";
    root.append(newChip);
    document.body.append(root);

    const event: CalendarEvent = {
      id: "event",
      title: "Moved event",
      start: new Date("2026-08-18T07:00:00.000Z"),
      end: new Date("2026-08-19T07:00:00.000Z"),
    };
    const occurrence: EventCalendarOccurrence = {
      key: "event::moved",
      eventId: "event",
      event,
      start: event.start,
      end: event.end,
      allDay: true,
    };
    const segments: EventCalendarSegment[] = [
      {
        occurrence,
        day: event.start,
        isStart: true,
        isEnd: true,
        continuesBefore: false,
        continuesAfter: false,
      },
    ];

    restoreEventCalendarChipFocus(root, segments);
    expect(document.activeElement).toBe(newChip);

    root.remove();
  });
});
