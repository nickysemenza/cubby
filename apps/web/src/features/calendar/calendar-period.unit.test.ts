import { TZDate } from "@date-fns/tz";
import { describe, expect, it } from "vitest";

import { formatPlainDate } from "~/lib/plain-date";

import {
  formatCalendarPeriodTitle,
  getCalendarPeriodRange,
  shiftCalendarPeriod,
} from "./calendar-period";

const zone = "America/Los_Angeles";

describe("calendar period", () => {
  it("builds an exact Sunday-to-Sunday week across spring-forward", () => {
    const range = getCalendarPeriodRange(
      new TZDate(2026, 2, 11, 12, 0, 0, zone),
      "week",
    );

    expect(formatPlainDate(range.activeStart)).toBe("2026-03-08");
    expect(formatPlainDate(range.activeEnd)).toBe("2026-03-15");
    expect(range.visibleStart).toBe(range.activeStart);
    expect(range.visibleEnd).toBe(range.activeEnd);
    expect(range.activeEnd.getTime() - range.activeStart.getTime()).toBe(
      167 * 60 * 60_000,
    );
  });

  it("keeps the six-week month query range", () => {
    const range = getCalendarPeriodRange(
      new TZDate(2026, 6, 14, 12, 0, 0, zone),
      "month",
    );

    expect(formatPlainDate(range.activeStart)).toBe("2026-07-01");
    expect(formatPlainDate(range.activeEnd)).toBe("2026-08-01");
    expect(formatPlainDate(range.visibleStart)).toBe("2026-06-28");
    expect(formatPlainDate(range.visibleEnd)).toBe("2026-08-09");
  });

  it("anchors Schedule to the calendar month without six-week grid padding", () => {
    const anchor = new TZDate(2026, 6, 14, 12, 0, 0, zone);
    const range = getCalendarPeriodRange(anchor, "schedule");

    expect(formatPlainDate(range.activeStart)).toBe("2026-07-01");
    expect(formatPlainDate(range.activeEnd)).toBe("2026-08-01");
    expect(range.visibleStart).toBe(range.activeStart);
    expect(range.visibleEnd).toBe(range.activeEnd);
    expect(formatPlainDate(shiftCalendarPeriod(anchor, "schedule", 1))).toBe(
      "2026-08-14",
    );
  });

  it("snaps a fortnight to the anchor week and spans fourteen days", () => {
    const range = getCalendarPeriodRange(
      new TZDate(2026, 7, 20, 12, 0, 0, zone),
      "fortnight",
    );

    expect(formatPlainDate(range.activeStart)).toBe("2026-08-16");
    expect(formatPlainDate(range.activeEnd)).toBe("2026-08-30");
    // The 2x7 grid queries exactly what it paints - no six-week padding.
    expect(range.visibleStart).toBe(range.activeStart);
    expect(range.visibleEnd).toBe(range.activeEnd);
  });

  it("steps by the selected period across a year boundary", () => {
    const anchor = new TZDate(2026, 11, 30, 12, 0, 0, zone);

    expect(formatPlainDate(shiftCalendarPeriod(anchor, "week", 1))).toBe(
      "2027-01-06",
    );
    expect(formatPlainDate(shiftCalendarPeriod(anchor, "month", 1))).toBe(
      "2027-01-30",
    );
    expect(formatPlainDate(shiftCalendarPeriod(anchor, "fortnight", 1))).toBe(
      "2027-01-13",
    );
    expect(formatPlainDate(shiftCalendarPeriod(anchor, "fortnight", -1))).toBe(
      "2026-12-16",
    );
  });

  it("formats compact same-month, cross-month, and cross-year week labels", () => {
    expect(
      formatCalendarPeriodTitle(
        new TZDate(2026, 7, 16, 0, 0, 0, zone),
        "week",
        new TZDate(2026, 7, 23, 0, 0, 0, zone),
      ),
    ).toBe("Aug 16–22, 2026");
    expect(
      formatCalendarPeriodTitle(
        new TZDate(2026, 7, 30, 0, 0, 0, zone),
        "week",
        new TZDate(2026, 8, 6, 0, 0, 0, zone),
      ),
    ).toBe("Aug 30–Sep 5, 2026");
    expect(
      formatCalendarPeriodTitle(
        new TZDate(2026, 11, 27, 0, 0, 0, zone),
        "week",
        new TZDate(2027, 0, 3, 0, 0, 0, zone),
      ),
    ).toBe("Dec 27, 2026–Jan 2, 2027");
  });

  it("labels a fortnight by its range, not the anchor month", () => {
    expect(
      formatCalendarPeriodTitle(
        new TZDate(2026, 7, 16, 0, 0, 0, zone),
        "fortnight",
        new TZDate(2026, 7, 30, 0, 0, 0, zone),
      ),
    ).toBe("Aug 16–29, 2026");
    expect(
      formatCalendarPeriodTitle(
        new TZDate(2026, 7, 30, 0, 0, 0, zone),
        "fortnight",
        new TZDate(2026, 8, 13, 0, 0, 0, zone),
      ),
    ).toBe("Aug 30–Sep 12, 2026");
  });
});
