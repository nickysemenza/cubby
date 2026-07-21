import { describe, expect, it } from "vitest";
import {
  buildTicks,
  diffDays,
  fromDayIndex,
  MONTH_TICK_MAX_SPAN_DAYS,
  QUARTER_TICK_MAX_SPAN_DAYS,
  toDayIndex,
  WEEKEND_BAND_MAX_SPAN_DAYS,
  weekendBands,
} from "./gantt-date";

describe("toDayIndex / fromDayIndex", () => {
  it("round-trips a plain date", () => {
    const plain = "2026-07-20";
    expect(fromDayIndex(toDayIndex(plain))).toBe(plain);
  });

  it("round-trips across a DST spring-forward boundary (US, 2024-03-10)", () => {
    // Pure UTC day-index math must be unaffected by any local DST rules.
    const before = "2024-03-09";
    const boundary = "2024-03-10";
    const after = "2024-03-11";
    expect(fromDayIndex(toDayIndex(boundary))).toBe(boundary);
    expect(diffDays(before, boundary)).toBe(1);
    expect(diffDays(boundary, after)).toBe(1);
    expect(diffDays(before, after)).toBe(2);
  });

  it("round-trips across a DST fall-back boundary (US, 2024-11-03)", () => {
    const before = "2024-11-02";
    const boundary = "2024-11-03";
    expect(fromDayIndex(toDayIndex(boundary))).toBe(boundary);
    expect(diffDays(before, boundary)).toBe(1);
  });

  it("epoch day 0 is 1970-01-01", () => {
    expect(toDayIndex("1970-01-01")).toBe(0);
    expect(fromDayIndex(0)).toBe("1970-01-01");
  });
});

describe("diffDays", () => {
  it("counts whole days between two plain dates", () => {
    expect(diffDays("2026-01-01", "2026-01-31")).toBe(30);
    expect(diffDays("2026-01-31", "2026-01-01")).toBe(-30);
    expect(diffDays("2026-07-20", "2026-07-20")).toBe(0);
  });

  it("handles a leap-year February correctly", () => {
    expect(diffDays("2024-02-28", "2024-03-01")).toBe(2); // 2024 is a leap year
    expect(diffDays("2023-02-28", "2023-03-01")).toBe(1); // 2023 is not
  });
});

describe("buildTicks granularity thresholds", () => {
  const start = toDayIndex("2020-01-01");

  it("uses month ticks at and below the month threshold", () => {
    const end = start + MONTH_TICK_MAX_SPAN_DAYS;
    const ticks = buildTicks(start, end);
    expect(ticks[0]?.label).toMatch(/^[A-Z][a-z]{2} '\d{2}$/);
  });

  it("switches to quarter ticks just above the month threshold", () => {
    const end = start + MONTH_TICK_MAX_SPAN_DAYS + 1;
    const ticks = buildTicks(start, end);
    expect(ticks[0]?.label).toMatch(/^Q[1-4] '\d{2}$/);
  });

  it("uses quarter ticks at the quarter threshold", () => {
    const end = start + QUARTER_TICK_MAX_SPAN_DAYS;
    const ticks = buildTicks(start, end);
    expect(ticks[0]?.label).toMatch(/^Q[1-4] '\d{2}$/);
  });

  it("switches to year ticks just above the quarter threshold", () => {
    const end = start + QUARTER_TICK_MAX_SPAN_DAYS + 1;
    const ticks = buildTicks(start, end);
    expect(ticks[0]?.label).toMatch(/^\d{4}$/);
  });

  it("labels a January month tick as major and Jan '24 style", () => {
    const jan2024 = toDayIndex("2024-01-01");
    const ticks = buildTicks(jan2024, jan2024 + 60);
    const first = ticks[0];
    expect(first?.label).toBe("Jan '24");
    expect(first?.major).toBe(true);
  });
});

describe("weekendBands", () => {
  it("finds a Saturday+Sunday band within a short window", () => {
    // 1970-01-01 is a Thursday, so days 2/3 are the first Sat/Sun.
    const bands = weekendBands(0, 6);
    expect(bands).toEqual([{ startDay: 2, endDay: 3 }]);
  });

  it("returns [] beyond the max span", () => {
    const bands = weekendBands(0, WEEKEND_BAND_MAX_SPAN_DAYS + 1);
    expect(bands).toEqual([]);
  });

  it("returns bands right at the max span", () => {
    const bands = weekendBands(0, WEEKEND_BAND_MAX_SPAN_DAYS);
    expect(bands.length).toBeGreaterThan(0);
  });

  it("handles a window starting on a lone Sunday", () => {
    // Day 3 (1970-01-04) is a Sunday; day 2 (Saturday) is outside the window.
    const bands = weekendBands(3, 10);
    expect(bands[0]).toEqual({ startDay: 3, endDay: 3 });
  });
});
