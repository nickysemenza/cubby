import { describe, expect, it } from "vitest";

import {
  clampWindow,
  FALLBACK_MAX_SPAN_DAYS,
  MAX_SPAN_PAD_DAYS,
  MIN_SPAN_DAYS,
  PAN_PAD_DAYS,
  spanOf,
} from "./gantt-window";

/** A 100-day extent, days 1000..1099. */
const EXTENT = { startDay: 1000, endDay: 1099 };

describe("spanOf", () => {
  it("counts inclusively, so a single day spans 1", () => {
    expect(spanOf({ startDay: 5, endDay: 5 })).toBe(1);
    expect(spanOf({ startDay: 5, endDay: 9 })).toBe(5);
  });
});

describe("clampWindow span", () => {
  it("refuses to zoom in past MIN_SPAN_DAYS", () => {
    const out = clampWindow({ startDay: 1000, endDay: 1001 }, EXTENT);
    expect(spanOf(out)).toBe(MIN_SPAN_DAYS);
  });

  it("refuses to zoom out past the extent plus MAX_SPAN_PAD_DAYS", () => {
    const out = clampWindow({ startDay: -50_000, endDay: 50_000 }, EXTENT);
    expect(spanOf(out)).toBe(spanOf(EXTENT) + MAX_SPAN_PAD_DAYS);
  });

  it("falls back to a fixed ceiling when there's no extent", () => {
    const out = clampWindow({ startDay: 0, endDay: 50_000 }, null);
    expect(spanOf(out)).toBe(FALLBACK_MAX_SPAN_DAYS);
  });

  it("snaps fractional days onto integers", () => {
    const out = clampWindow({ startDay: 1000.4, endDay: 1060.6 }, EXTENT);
    expect(Number.isInteger(out.startDay)).toBe(true);
    expect(Number.isInteger(out.endDay)).toBe(true);
  });
});

describe("clampWindow position", () => {
  // The bug this guards: the start used to be free, so panning could drag
  // every bar off the edge and leave the viewer staring at empty months.
  it("stops panning left at PAN_PAD_DAYS before the extent", () => {
    const out = clampWindow({ startDay: -9999, endDay: -9999 + 59 }, EXTENT);
    expect(out.startDay).toBe(EXTENT.startDay - PAN_PAD_DAYS);
  });

  it("stops panning right at PAN_PAD_DAYS after the extent", () => {
    const span = 60;
    const out = clampWindow(
      { startDay: 9999, endDay: 9999 + span - 1 },
      EXTENT,
    );
    expect(out.endDay).toBe(EXTENT.endDay + PAN_PAD_DAYS);
    expect(spanOf(out)).toBe(span);
  });

  it("never lets the data leave the window, however hard you pan", () => {
    // Whatever the user throws at it, some part of the extent stays visible.
    for (const attempt of [-100_000, -500, 0, 1050, 5_000, 100_000]) {
      const out = clampWindow(
        { startDay: attempt, endDay: attempt + 59 },
        EXTENT,
      );
      expect(out.endDay).toBeGreaterThanOrEqual(EXTENT.startDay);
      expect(out.startDay).toBeLessThanOrEqual(EXTENT.endDay);
    }
  });

  it("leaves a window already inside the bounds untouched", () => {
    const inside = { startDay: 1010, endDay: 1069 };
    expect(clampWindow(inside, EXTENT)).toEqual(inside);
  });

  it("centres the data when zoomed out wider than the padded extent", () => {
    // At max zoom-out the span exceeds the pannable range, so the clamp would
    // invert; it centres instead. PAN_PAD_DAYS being half MAX_SPAN_PAD_DAYS
    // makes the centred window exactly the padded extent.
    const out = clampWindow({ startDay: -50_000, endDay: 50_000 }, EXTENT);
    expect(out.startDay).toBe(EXTENT.startDay - PAN_PAD_DAYS);
    expect(out.endDay).toBe(EXTENT.endDay + PAN_PAD_DAYS);
  });

  it("leaves the position free when there's no extent to anchor to", () => {
    const out = clampWindow({ startDay: 7000, endDay: 7059 }, null);
    expect(out.startDay).toBe(7000);
  });

  it("keeps a single-day extent visible", () => {
    const point = { startDay: 2000, endDay: 2000 };
    const out = clampWindow({ startDay: 90_000, endDay: 90_059 }, point);
    expect(out.startDay).toBeLessThanOrEqual(2000);
    expect(out.endDay).toBeGreaterThanOrEqual(2000);
  });
});
