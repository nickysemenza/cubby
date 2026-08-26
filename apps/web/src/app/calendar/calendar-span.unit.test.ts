import type { CalendarItem } from "@cubby/schemas/calendar";
import { testShortcode } from "@cubby/schemas/testing";

import { describe, expect, it } from "vitest";
import { itemSpanLabel } from "./calendar-span";

const projectSpan = (
  startDate: string,
  endDateExclusive: string,
): CalendarItem => ({
  kind: "project",
  id: testShortcode("project", "PRJ-4K7M"),
  title: "Kitchen Remodel",
  startDate,
  endDateExclusive,
  interaction: "read-only",
  status: "in_progress",
  projectKind: null,
});

describe("itemSpanLabel", () => {
  it("returns null for a single-day item", () => {
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-10-04"))).toBeNull();
  });

  it("renders the INCLUSIVE end, one day back from endDateExclusive", () => {
    // The off-by-one that matters: exclusive 2026-11-13 is an inclusive Nov 12.
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-11-13"))).toBe(
      "Oct 3 — Nov 12",
    );
  });

  it("qualifies both ends with the year when the span crosses one", () => {
    expect(itemSpanLabel(projectSpan("2025-12-01", "2027-07-02"))).toBe(
      "Dec 1, 2025 — Jul 1, 2027",
    );
  });

  it("returns null for a degenerate span whose end precedes its start", () => {
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-10-01"))).toBeNull();
  });
});
