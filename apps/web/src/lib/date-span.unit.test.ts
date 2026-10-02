import { describe, expect, it } from "vitest";

import { formatDateSpan } from "./date-span";

const TODAY = "2026-09-22";
const span = (start: string | null, end: string | null) =>
  formatDateSpan(start, end, TODAY);

describe("formatDateSpan", () => {
  it("collapses a null or equal end to one day", () => {
    expect(span("2026-09-22", null)).toBe("Sep 22");
    expect(span("2026-09-22", "2026-09-22")).toBe("Sep 22");
  });

  it("names the month once inside one month", () => {
    expect(span("2026-09-22", "2026-09-25")).toBe("Sep 22 – 25");
  });

  it("names both months across a month boundary", () => {
    expect(span("2026-09-30", "2026-10-02")).toBe("Sep 30 – Oct 2");
  });

  it("shows the year when it is not the current year", () => {
    expect(span("2027-03-01", null)).toBe("Mar 1, 2027");
    expect(span("2027-03-01", "2027-03-04")).toBe("Mar 1 – 4, 2027");
    expect(span("2025-11-30", "2025-12-02")).toBe("Nov 30 – Dec 2, 2025");
  });

  it("shows both years when the ends differ in year", () => {
    expect(span("2026-12-30", "2027-01-02")).toBe("Dec 30, 2026 – Jan 2, 2027");
  });

  it("falls back for missing or unreadable ends", () => {
    expect(span(null, null)).toBe("No date");
    expect(span(null, "2026-09-25")).toBe("Sep 25");
    expect(span("not-a-date", "2026-09-25")).toBe("not-a-date – 2026-09-25");
  });
});
