import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  mapPlantingItems,
  type CalendarPlantingRow,
} from "./calendar-plantings";

const row = (
  overrides: Partial<CalendarPlantingRow> = {},
): CalendarPlantingRow => ({
  shortcode: testShortcode("planting", "PLT-4K7M"),
  plantName: "Brandywine",
  gardenGuideKey: "tomato",
  locationName: "Raised bed 2",
  plannedWindow: "Late spring",
  sowedOn: null,
  transplantedOn: null,
  finishedOn: null,
  ...overrides,
});

describe("mapPlantingItems", () => {
  it("emits one item per populated in-range milestone", () => {
    const items = mapPlantingItems(
      [row({ sowedOn: "2026-04-01", transplantedOn: "2026-05-15" })],
      { startDate: "2026-01-01", endDateExclusive: "2027-01-01" },
    );

    expect(items).toHaveLength(2);
    expect(
      items.map((item) => item.kind === "planting" && item.milestone),
    ).toEqual(["sowed", "transplanted"]);
    expect(items.every((item) => item.interaction === "read-only")).toBe(true);
  });

  it("shapes a milestone item as a single-day point event", () => {
    const [item] = mapPlantingItems([row({ sowedOn: "2026-04-01" })], {
      startDate: "2026-01-01",
      endDateExclusive: "2027-01-01",
    });

    expect(item).toMatchObject({
      kind: "planting",
      id: testShortcode("planting", "PLT-4K7M"),
      milestone: "sowed",
      title: "Brandywine · Tomato",
      locationName: "Raised bed 2",
      plannedWindow: "Late spring",
      startDate: "2026-04-01",
      endDateExclusive: "2026-04-02",
      interaction: "read-only",
    });
  });

  it("titles a species-level plant by its name alone", () => {
    const [item] = mapPlantingItems(
      [row({ plantName: "Tomato", sowedOn: "2026-03-01" })],
      { startDate: "2026-01-01", endDateExclusive: "2027-01-01" },
    );
    expect(item?.title).toBe("Tomato");
  });

  it("skips a populated milestone that falls outside the requested range", () => {
    // A row can be fetched because ONE milestone is in range while another
    // populated milestone on the same row is not — that other milestone must
    // not be emitted just because the row was.
    const items = mapPlantingItems(
      [
        row({
          sowedOn: "2026-04-01",
          finishedOn: "2025-01-01", // Outside the requested range below.
        }),
      ],
      { startDate: "2026-01-01", endDateExclusive: "2027-01-01" },
    );

    expect(
      items.map((item) => item.kind === "planting" && item.milestone),
    ).toEqual(["sowed"]);
  });

  it("emits nothing for a row with no milestone at all", () => {
    expect(
      mapPlantingItems([row()], {
        startDate: "2026-01-01",
        endDateExclusive: "2027-01-01",
      }),
    ).toEqual([]);
  });
});
