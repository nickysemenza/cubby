import { TZDate } from "@date-fns/tz";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatCalendarDay,
  formatInstant,
  formatRelative,
} from "./date-format";

// Household zone is America/Los_Angeles: PDT (UTC-7) until 2026-11-01 02:00
// local, PST (UTC-8) after; PST until 2026-03-08 02:00 local, PDT after.
const PDT_MIDNIGHT = "2026-07-22T07:00:00Z";
const PDT_LAST_SECOND = "2026-07-22T06:59:59Z";

describe("formatInstant", () => {
  it("rolls the calendar day at household midnight, not UTC or process midnight", () => {
    expect(formatInstant(PDT_LAST_SECOND, "dateShort")).toBe("Jul 21, 2026");
    expect(formatInstant(PDT_MIDNIGHT, "dateShort")).toBe("Jul 22, 2026");
  });

  it("accepts a Date, an ISO string, or epoch milliseconds for the same instant", () => {
    const iso = "2026-07-22T19:30:45Z";
    const expected = "7/22/2026, 12:30:45 PM";
    expect(formatInstant(iso, "dateTime")).toBe(expected);
    expect(formatInstant(new Date(iso), "dateTime")).toBe(expected);
    expect(formatInstant(Date.parse(iso), "dateTime")).toBe(expected);
  });

  it("follows the household offset across the spring-forward gap", () => {
    expect(formatInstant("2026-03-08T07:59:59Z", "dateShort")).toBe(
      "Mar 7, 2026",
    );
    expect(formatInstant("2026-03-08T08:00:00Z", "dateShort")).toBe(
      "Mar 8, 2026",
    );
    // 01:59:59 PST, then the clock jumps to 03:00:00 PDT.
    expect(formatInstant("2026-03-08T09:59:59Z", "time")).toBe("1:59:59 AM");
    expect(formatInstant("2026-03-08T10:00:00Z", "time")).toBe("3:00:00 AM");
  });

  it("follows the household offset across the fall-back repeat hour", () => {
    expect(formatInstant("2026-11-01T06:59:59Z", "dateShort")).toBe(
      "Oct 31, 2026",
    );
    expect(formatInstant("2026-11-01T07:00:00Z", "dateShort")).toBe(
      "Nov 1, 2026",
    );
    // 01:30 occurs twice: once as PDT, once as PST.
    expect(formatInstant("2026-11-01T08:30:00Z", "time")).toBe("1:30:00 AM");
    expect(formatInstant("2026-11-01T09:30:00Z", "time")).toBe("1:30:00 AM");
    expect(formatInstant("2026-11-01T10:00:00Z", "time")).toBe("2:00:00 AM");
  });

  it("formats in an explicit zone when one is pinned", () => {
    expect(formatInstant("2026-06-12T03:00:00Z", "monthDay", "UTC")).toBe(
      "Jun 12",
    );
    expect(formatInstant("2026-06-12T03:00:00Z", "monthDay")).toBe("Jun 11");
  });

  it("renders Invalid Date for an unparseable instant, like Date#toLocaleString", () => {
    expect(formatInstant("not-a-date", "dateTime")).toBe("Invalid Date");
    expect(formatInstant(Number.NaN, "time")).toBe("Invalid Date");
  });

  describe("presets", () => {
    const instant = "2026-01-05T21:04:09Z"; // Mon 13:04:09 PST
    const cases = [
      ["dateShort", "Jan 5, 2026"],
      ["dateShortPadded", "Jan 05, 2026"],
      ["dateNumeric", "1/5/2026"],
      ["dateTime", "1/5/2026, 1:04:09 PM"],
      ["time", "1:04:09 PM"],
      ["isoDateTime", "2026-01-05 13:04"],
      ["isoDateTimeSeconds", "2026-01-05 13:04:09"],
      ["monthYear", "Jan 2026"],
      ["weekdayDatePadded", "Mon, Jan 05, 2026"],
    ] as const;
    it.each(cases)("%s", (preset, expected) => {
      expect(formatInstant(instant, preset)).toBe(expected);
    });

    it("uses a plain ASCII space before AM/PM", () => {
      expect(formatInstant(instant, "time")).not.toMatch(/ /);
    });

    it("dateTime shows 12 AM/PM correctly at the household noon and midnight", () => {
      expect(formatInstant("2026-01-05T08:00:00Z", "time")).toBe("12:00:00 AM");
      expect(formatInstant("2026-01-05T20:00:00Z", "time")).toBe("12:00:00 PM");
    });
  });
});

describe("formatCalendarDay", () => {
  it("never shifts a plain date across zones", () => {
    // parseISO/new Date("2026-01-05") would be UTC midnight = Jan 4 in PST.
    expect(formatCalendarDay("2026-01-05", "dateShort")).toBe("Jan 5, 2026");
    expect(formatCalendarDay("2026-07-22", "dateShort")).toBe("Jul 22, 2026");
    expect(formatCalendarDay("2026-03-08", "dateShort")).toBe("Mar 8, 2026");
    expect(formatCalendarDay("2026-11-01", "dateShort")).toBe("Nov 1, 2026");
  });

  it("formats a local or zoned calendar Date by its own components", () => {
    expect(formatCalendarDay(new Date(2026, 0, 5), "dateShort")).toBe(
      "Jan 5, 2026",
    );
    // A TZDate keeps its own zone; it must not be re-projected into ours.
    const tokyo = new TZDate(2026, 0, 5, 23, 30, "Asia/Tokyo");
    expect(formatCalendarDay(tokyo, "dateShort")).toBe("Jan 5, 2026");
    const auckland = new TZDate(2026, 0, 5, 0, 0, "Pacific/Auckland");
    expect(formatCalendarDay(auckland, "dateShort")).toBe("Jan 5, 2026");
  });

  it("hands back the raw string when it is not a plain date", () => {
    expect(formatCalendarDay("not-a-date", "dateShort")).toBe("not-a-date");
    expect(formatCalendarDay("2026-13-45", "dateShort")).toBe("2026-13-45");
    expect(formatCalendarDay("", "dateShort")).toBe("");
  });

  describe("presets", () => {
    const day = "2026-01-05"; // Monday
    const cases = [
      ["dateShort", "Jan 5, 2026"],
      ["monthDay", "Jan 5"],
      ["monthShort", "Jan"],
      ["monthYearCompact", "Jan 26"],
      ["monthYearLong", "January 2026"],
      ["weekdayMonthDay", "Mon, Jan 5"],
      ["weekdayNumeric", "Mon 1/5"],
      ["weekdayLongMonthDay", "Monday, January 5"],
    ] as const;
    it.each(cases)("%s", (preset, expected) => {
      expect(formatCalendarDay(day, preset)).toBe(expected);
    });
  });
});

describe("formatRelative", () => {
  afterEach(() => vi.useRealTimers());

  it("suffixes past instants with ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
    expect(formatRelative(new Date("2026-07-22T09:00:00Z"))).toBe(
      "about 3 hours ago",
    );
    expect(formatRelative("2026-07-20T12:00:00Z")).toBe("2 days ago");
  });

  it("prefixes future instants with in", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
    expect(formatRelative(Date.parse("2026-07-22T15:00:00Z"))).toBe(
      "in about 3 hours",
    );
  });
});
