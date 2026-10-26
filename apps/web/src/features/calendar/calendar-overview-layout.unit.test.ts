import { describe, expect, it } from "vitest";

import { calendarOverviewLayout } from "./calendar-overview-layout";

describe("calendar overview fitting", () => {
  it("keeps an event lane in a desktop year when a wider aligned row can fit it", () => {
    const result = calendarOverviewLayout({
      width: 1264,
      height: 870,
      dayCount: 366,
      startWeekday: 6,
      aligned: true,
    });
    expect(result.lanes).toBeGreaterThanOrEqual(1);
    expect(1264 / result.columns).toBeGreaterThanOrEqual(36);
  });

  it("fits every leap-year day and weekday padding without clipping the final row", () => {
    const aligned = calendarOverviewLayout({
      width: 1400,
      height: 800,
      dayCount: 366,
      startWeekday: 6,
      aligned: true,
    });
    expect(aligned.columns % 7).toBe(0);
    expect(aligned.offset).toBe(6);
    expect(aligned.rows * aligned.columns).toBeGreaterThanOrEqual(372);
    expect((aligned.rows - 1) * aligned.columns).toBeLessThan(372);
    expect(aligned.lanes * 18 + 36).toBeLessThanOrEqual(800 / aligned.rows);
    const free = calendarOverviewLayout({
      width: 1400,
      height: 800,
      dayCount: 366,
      startWeekday: 6,
      aligned: false,
    });
    expect(free.offset).toBe(0);
    expect(free.rows * free.columns).toBeGreaterThanOrEqual(366);
  });

  it("uses overflow instead of painting event lanes into the next row in short windows", () => {
    const result = calendarOverviewLayout({
      width: 800,
      height: 200,
      dayCount: 365,
      startWeekday: 4,
      aligned: true,
    });
    expect(result.lanes).toBe(0);
    expect(result.columns).toBeGreaterThan(0);
    expect(result.rows).toBeGreaterThan(0);
  });
});
