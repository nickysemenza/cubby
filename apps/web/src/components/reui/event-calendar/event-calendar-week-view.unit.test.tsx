import { TZDate } from "@date-fns/tz";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WeekEventCalendar } from "./event-calendar";
import type { CalendarEvent } from "./event-calendar-types";

const zone = "America/Los_Angeles";
const day = (date: number) => new TZDate(2026, 6, date, 0, 0, 0, zone);

const event = (
  id: string,
  startDay: number,
  endDay: number,
): CalendarEvent => ({
  id,
  title: id,
  start: day(startDay),
  end: day(endDay),
  allDay: true,
});

describe("WeekEventCalendar", () => {
  it("renders spans once above uncapped single-day columns", () => {
    const busyDay = Array.from({ length: 9 }, (_, index) =>
      event(`single-${index}`, 6, 7),
    );
    const { container } = render(
      <WeekEventCalendar
        events={[event("crossing-span", 4, 8), ...busyDay]}
        date={day(8)}
        timeZone={zone}
        renderEvent={({ occurrence }) => occurrence.event.title}
        onEventsChange={() => undefined}
      />,
    );

    expect(screen.getAllByText("crossing-span")).toHaveLength(1);
    for (const item of busyDay) {
      expect(screen.getByText(item.title)).toBeInTheDocument();
    }
    expect(container.querySelector('[data-slot="event-calendar-more"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="event-calendar-week-day"]'),
    ).toHaveLength(7);
  });

  it("opens blank days and event segments on their displayed dates", () => {
    const onSlotClick = vi.fn();
    const onEventClick = vi.fn();
    const { container } = render(
      <WeekEventCalendar
        events={[event("span", 4, 8)]}
        date={day(8)}
        timeZone={zone}
        renderEvent={({ occurrence }) => occurrence.event.title}
        onEventsChange={() => undefined}
        onSlotClick={onSlotClick}
        onEventClick={onEventClick}
      />,
    );

    const tuesday = container.querySelector<HTMLElement>(
      '[data-slot="event-calendar-week-day"][aria-label="Tuesday, July 7"]',
    );
    expect(tuesday).not.toBeNull();
    if (tuesday) fireEvent.click(tuesday);
    expect(onSlotClick.mock.calls[0]?.[0]).toMatchObject({
      allDay: true,
      period: "week",
    });
    expect(onSlotClick.mock.calls[0]?.[0].date.getDate()).toBe(7);

    fireEvent.click(screen.getByRole("button", { name: /span/ }));
    expect(onEventClick.mock.calls[0]?.[1].day.getDate()).toBe(5);
  });
});
