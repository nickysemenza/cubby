import type { CalendarItem } from "@cubby/schemas/calendar";
import { testShortcode } from "@cubby/schemas/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const plantingMilestone: CalendarItem = {
  kind: "planting",
  id: testShortcode("planting", "PLT-3B2C"),
  milestone: "sowed",
  title: "Tomato · Brandywine",
  locationName: "Raised bed 2",
  plannedWindow: "Late spring",
  startDate: "2026-10-03",
  endDateExclusive: "2026-10-04",
  interaction: "read-only",
};

describe("itemSpanLabel", () => {
  // The span format omits the year only for the household's current year.
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-01T19:00:00Z"),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for a single-day item", () => {
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-10-04"))).toBeNull();
  });

  it("returns null for a single-day planting milestone", () => {
    // Every planting item is a one-day point event (see mapPlantingItems), so
    // it never earns a span label — same rule as a meal or a 1-day task.
    expect(itemSpanLabel(plantingMilestone)).toBeNull();
  });

  it("renders the INCLUSIVE end, one day back from endDateExclusive", () => {
    // The off-by-one that matters: exclusive 2026-11-13 is an inclusive Nov 12.
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-11-13"))).toBe(
      "Oct 3 – Nov 12",
    );
  });

  it("qualifies both ends with the year when the span crosses one", () => {
    expect(itemSpanLabel(projectSpan("2025-12-01", "2027-07-02"))).toBe(
      "Dec 1, 2025 – Jul 1, 2027",
    );
  });

  it("returns null for a degenerate span whose end precedes its start", () => {
    expect(itemSpanLabel(projectSpan("2026-10-03", "2026-10-01"))).toBeNull();
  });
});
