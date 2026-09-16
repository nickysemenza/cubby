import type { CalendarItem } from "@cubby/schemas/calendar";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";
import type { getCalendarRange } from "~/server/repo/calendar";

import { buildCalendarSnapshot, MAX_CALENDAR_DOCUMENT_BYTES } from "./snapshot";

const database = new Database(() => {
  throw new Error("Snapshot unit tests must not open a database");
});
const now = new Date("2026-09-03T12:00:00.000Z");

const meal = (title = "Dinner"): CalendarItem => ({
  kind: "meal",
  id: testShortcode("meal", "MEL-4K7M"),
  title,
  name: null,
  startDate: "2026-09-03",
  endDateExclusive: "2026-09-04",
  interaction: "move",
  sortOrder: null,
  mealType: "dinner",
  mealKind: "cooked",
  recipeNames: ["Soup"],
  coverImageUrl: null,
  mealTotals: withMacros({
    cost: {
      status: "complete",
      lower: 5,
      upper: null,
      coverage: { covered: 1, total: 1 },
    },
    nutrition: buildNutrition((key) =>
      key === "kcal"
        ? {
            status: "complete",
            lower: 400,
            upper: null,
            coverage: { covered: 1, total: 1 },
          }
        : { status: "unavailable", reason: "no_data" },
    ),
  }),
});

const task = (): CalendarItem => ({
  kind: "task",
  id: testShortcode("task", "TSK-9H64"),
  title: "Water plants",
  startDate: "2026-09-04",
  endDateExclusive: "2026-09-05",
  interaction: "move",
  dueDate: "2026-09-04",
  dueEndDate: null,
  status: "not_started",
  trade: "other",
  projectName: null,
  subjectProductName: null,
  coverImageUrl: null,
});

const planting = (): CalendarItem => ({
  kind: "planting",
  id: testShortcode("planting", "PLT-3B2C"),
  milestone: "sowed",
  title: "Tomato · Brandywine",
  locationName: "Raised bed 2",
  plannedWindow: "Late spring",
  startDate: "2026-09-05",
  endDateExclusive: "2026-09-06",
  interaction: "read-only",
});

describe("calendar snapshot", () => {
  it("renders all feed variants from one range read and one timestamp", async () => {
    const getRange = vi.fn<typeof getCalendarRange>(async () => ({
      items: [meal(), task()],
      days: {},
    }));
    const snapshot = await buildCalendarSnapshot(
      database,
      { origin: "https://cubby.example", now, revision: 7 },
      getRange,
    );

    expect(getRange).toHaveBeenCalledOnce();
    expect(snapshot.counts).toEqual({ meals: 1, tasks: 1, all: 2, garden: 0 });
    expect(snapshot.documents.meals.body).toContain("MEL-4K7M");
    expect(snapshot.documents.meals.body).not.toContain("TSK-9H64");
    expect(snapshot.documents.tasks.body).toContain("TSK-9H64");
    expect(snapshot.documents.all.body).toContain("MEL-4K7M");
    expect(snapshot.documents.all.body).toContain("TSK-9H64");
    expect(
      new Set(Object.values(snapshot.documents).map((d) => d.generatedAt)),
    ).toEqual(new Set([now.toISOString()]));
  });

  it("renders the garden feed from the same range read", async () => {
    const getRange = vi.fn<typeof getCalendarRange>(async () => ({
      items: [meal(), task(), planting()],
      days: {},
    }));
    const snapshot = await buildCalendarSnapshot(
      database,
      { origin: "https://cubby.example", now, revision: 7 },
      getRange,
    );

    // One range read still covers every feed, garden included.
    expect(getRange).toHaveBeenCalledOnce();
    expect(snapshot.counts).toEqual({ meals: 1, tasks: 1, all: 2, garden: 1 });
    expect(snapshot.documents.garden.body).toContain("PLT-3B2C");
    // `all` is the long-subscribed meals+tasks feed and must not silently
    // start publishing plantings too.
    expect(snapshot.documents.all.body).not.toContain("PLT-3B2C");
  });

  it("produces stable ETags for unchanged rendered bytes", async () => {
    const getRange = vi.fn<typeof getCalendarRange>(async () => ({
      items: [meal()],
      days: {},
    }));
    const first = await buildCalendarSnapshot(
      database,
      { origin: "https://cubby.example", now, revision: 1 },
      getRange,
    );
    const second = await buildCalendarSnapshot(
      database,
      { origin: "https://cubby.example", now, revision: 2 },
      getRange,
    );
    expect(second.documents.all.etag).toBe(first.documents.all.etag);
  });

  it("rejects a document above the Durable Object value limit", async () => {
    const getRange = vi.fn<typeof getCalendarRange>(async () => ({
      items: [meal("x".repeat(MAX_CALENDAR_DOCUMENT_BYTES))],
      days: {},
    }));
    await expect(
      buildCalendarSnapshot(
        database,
        { origin: "https://cubby.example", now, revision: 1 },
        getRange,
      ),
    ).rejects.toThrow("maximum");
  });
});
