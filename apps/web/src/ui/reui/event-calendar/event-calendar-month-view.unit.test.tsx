import { TZDate } from "@date-fns/tz";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FortnightEventCalendar } from "./event-calendar";
import type { CalendarEvent } from "./event-calendar-types";

const zone = "America/Los_Angeles";
const day = (date: number) => new TZDate(2026, 6, date, 0, 0, 0, zone);

/** A lane of nothing but crossing bars; each is one line of text. */
const SPAN_LANE = "var(--ec-month-span-h, var(--ec-month-bar-h, 1.75rem))";
/** A lane a single-day chip can reach, so it holds the full chip height. */
const CHIP_LANE = "var(--ec-month-bar-h, 1.75rem)";

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

const overlay = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(
    '[data-slot="event-calendar-month-bar-overlay"]',
  );

const renderFortnight = (events: CalendarEvent[]) =>
  render(
    <FortnightEventCalendar
      events={events}
      // A Wednesday: the grid still starts on its Sunday.
      date={day(8)}
      timeZone={zone}
      renderEvent={({ occurrence }) => occurrence.event.title}
      onEventsChange={() => undefined}
    />,
  );

describe("EventCalendarMonthView", () => {
  it("paints fourteen week-aligned cells for a fortnight", () => {
    const { container } = renderFortnight([]);

    expect(
      container.querySelectorAll('[data-slot="event-calendar-month-cell"]'),
    ).toHaveLength(14);
    // Active === visible, so nothing is dimmed as an outside day.
    expect(
      container.querySelectorAll(
        '[data-slot="event-calendar-month-cell"][data-outside]',
      ),
    ).toHaveLength(0);
    expect(
      container.querySelector('[data-slot="event-calendar-month-view"]'),
    ).toHaveAttribute("data-view", "fortnight");
  });

  it("gives crossing-bar-only lanes the span height and keeps chip lanes tall", () => {
    const { container } = renderFortnight([
      event("crossing-span", 5, 9),
      event("overlapping-span", 5, 8),
      event("single-day", 6, 7),
    ]);

    expect(overlay(container)?.style.gridTemplateRows).toBe(
      [SPAN_LANE, SPAN_LANE, CHIP_LANE].join(" "),
    );
  });

  it("reserves the lanes a cell actually sits under, at their own heights", () => {
    const { container } = renderFortnight([
      event("crossing-span", 5, 9),
      event("overlapping-span", 5, 8),
      event("single-day", 6, 7),
    ]);
    // The fortnight starts on Sunday July 5, so cell 1 is Monday and cell 3 is
    // Wednesday.
    const cells = container.querySelectorAll<HTMLElement>(
      '[data-slot="event-calendar-month-cell"]',
    );
    const spacerHeight = (index: number) =>
      cells[index]?.querySelector<HTMLElement>('div[aria-hidden="true"]')?.style
        .height;

    // Monday sits under all three lanes; Wednesday only under the long span,
    // so its chips must not be pushed down by lanes that miss it.
    expect(spacerHeight(1)).toBe(
      `calc(${[SPAN_LANE, SPAN_LANE, CHIP_LANE].join(" + ")} - 0.125rem)`,
    );
    expect(spacerHeight(3)).toBe(`calc(${SPAN_LANE} - 0.125rem)`);
  });
});
