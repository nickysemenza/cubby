import { afterEach, describe, expect, it, vi } from "vitest";

import { dateSpanParts, formatDateSpan } from "./date-span";

const span = (start: string | null, end: string | null) =>
  formatDateSpan(start, end, "2026-12-31");

describe("formatDateSpan", () => {
  it("collapses a null or equal end to one day", () => {
    expect(span("2026-09-22", null)).toBe("Sep 22 (a few months ago)");
    expect(span("2026-09-22", "2026-09-22")).toBe("Sep 22 (a few months ago)");
  });

  it("names the month once inside one month", () => {
    expect(span("2026-09-22", "2026-09-25")).toBe(
      "Sep 22 – 25 (a few months ago)",
    );
  });

  it("names both months across a month boundary", () => {
    expect(span("2026-09-30", "2026-10-02")).toBe(
      "Sep 30 – Oct 2 (a few months ago)",
    );
  });

  it("shows the year when it is not the current year", () => {
    expect(span("2027-03-01", null)).toBe("Mar 1, 2027 (in a few months)");
    expect(span("2027-03-01", "2027-03-04")).toBe(
      "Mar 1 – 4, 2027 (in a few months)",
    );
    expect(span("2025-11-30", "2025-12-02")).toBe(
      "Nov 30 – Dec 2, 2025 (about a year ago)",
    );
  });

  it("shows both years when the ends differ in year", () => {
    expect(span("2026-12-30", "2027-01-02")).toBe(
      "Dec 30, 2026 – Jan 2, 2027 (ongoing)",
    );
  });

  it("falls back for missing or unreadable ends", () => {
    expect(span(null, null)).toBe("No date");
    expect(span(null, "2026-09-25")).toBe("Sep 25 (a few months ago)");
    expect(span("not-a-date", "2026-09-25")).toBe("not-a-date – 2026-09-25");
  });
});

// Isolated regressions: household midnight differs from UTC; DST days are not
// 24 hours; ongoing ranges must describe the interval rather than its past start.
describe("past, present and future date context", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2026-10-04", "Oct 4 (yesterday)"],
    ["2026-09-22", "Sep 22 (about a week ago)"],
    ["2025-10-05", "Oct 5, 2025 (about a year ago)"],
    ["2026-10-05", "Oct 5 (today)"],
    ["2026-10-06", "Oct 6 (tomorrow)"],
    ["2026-10-10", "Oct 10 (in a few days)"],
    ["2026-10-15", "Oct 15 (in about a week)"],
    ["2026-10-31", "Oct 31 (in a few weeks)"],
    ["2026-11-05", "Nov 5 (in about a month)"],
    ["2027-01-10", "Jan 10, 2027 (in a few months)"],
    ["2027-10-05", "Oct 5, 2027 (in about a year)"],
    ["2029-10-05", "Oct 5, 2029 (in about 3 years)"],
  ])("%s", (day, expected) => {
    expect(formatDateSpan(day, null, "2026-10-05")).toBe(expected);
  });

  it("describes ongoing ranges once and future ranges by their start", () => {
    expect(formatDateSpan("2026-10-01", "2026-10-08", "2026-10-05")).toBe(
      "Oct 1 – 8 (ongoing)",
    );
    expect(formatDateSpan("2026-10-06", "2026-10-08", "2026-10-05")).toBe(
      "Oct 6 – 8 (tomorrow)",
    );
    expect(formatDateSpan("2026-10-01", "2026-10-04", "2026-10-05")).toBe(
      "Oct 1 – 4 (yesterday)",
    );
  });

  it("uses the household day before UTC midnight and across DST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T02:00:00Z"));
    expect(formatDateSpan("2026-10-05", null)).toBe("Oct 5 (today)");
    vi.setSystemTime(new Date("2026-11-01T07:30:00Z"));
    expect(formatDateSpan("2026-11-02", null)).toBe("Nov 2 (tomorrow)");
    vi.setSystemTime(new Date("2026-03-08T08:30:00Z"));
    expect(formatDateSpan("2026-03-09", null)).toBe("Mar 9 (tomorrow)");
  });

  it("preserves impossible dates instead of rolling them forward", () => {
    expect(formatDateSpan("2026-02-30", null, "2026-02-01")).toBe("2026-02-30");
  });
});

// Stacked table dates print the day and its compact distance as separate
// lines; a calendar-day distance, never elapsed hours.
describe("dateSpanParts", () => {
  it.each([
    ["2026-10-05", { label: "Oct 5", relative: "today" }],
    ["2026-10-04", { label: "Oct 4", relative: "yesterday" }],
    ["2026-10-06", { label: "Oct 6", relative: "tomorrow" }],
    ["2026-09-30", { label: "Sep 30", relative: "5d ago" }],
    ["2026-10-24", { label: "Oct 24", relative: "in 3w" }],
    ["2027-05-14", { label: "May 14, 2027", relative: "in 7mo" }],
    ["2024-09-30", { label: "Sep 30, 2024", relative: "2y ago" }],
  ])("%s", (day, expected) => {
    expect(dateSpanParts(day, null, "2026-10-05")).toEqual(expected);
  });

  it("keeps ranges and unreadable values on the label line", () => {
    expect(dateSpanParts("2026-10-01", "2026-10-08", "2026-10-05")).toEqual({
      label: "Oct 1 – 8",
      relative: "ongoing",
    });
    expect(dateSpanParts(null, null, "2026-10-05")).toEqual({
      label: "No date",
      relative: null,
    });
    expect(dateSpanParts("2026-02-30", null, "2026-02-01")).toEqual({
      label: "2026-02-30",
      relative: null,
    });
  });
});
