import type { GardenGuideWindow } from "@cubby/schemas/garden-guide";
import type { PlantingOut } from "@cubby/schemas/planting";
import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { guideWindowSegments, plantingScheduleRows } from "./garden-schedule";

describe("garden schedule", () => {
  it("keeps a cited half-month window at its source precision and splits the year boundary", () => {
    const window: GardenGuideWindow = {
      sourceId: "example",
      microclimate: "sunny",
      method: "sow",
      months: [12, 1, 2],
      monthPart: "weeks-3-4",
      notes: null,
    };
    expect(
      guideWindowSegments(window, 2026, "example").map((segment) => [
        segment.startDate,
        segment.endDate,
        segment.variant,
      ]),
    ).toEqual([
      ["2026-01-16", "2026-01-31", "reference"],
      ["2026-02-16", "2026-02-28", "reference"],
      ["2026-12-16", "2026-12-31", "reference"],
    ]);
  });

  it("groups by current location and leaves free-text plans undated", () => {
    const planting = fromPartial<PlantingOut>({
      id: testShortcode("planting", "planned"),
      displayName: "Example crop",
      status: "planned",
      locationId: testShortcode("location", "bed"),
      locationName: "Example bed",
      plannedWindow: "after the rain",
      sowedOn: null,
      transplantedOn: null,
      expectedHarvestStart: null,
      expectedHarvestEnd: null,
      finishedOn: null,
    });
    const rows = plantingScheduleRows([planting], 2026);
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["Example bed", 0],
      ["Example crop", 1],
    ]);
    expect(rows[1]?.segments).toEqual([]);
    expect(rows[1]?.noDateLabel).toBe("Planned window: after the rain");
  });

  it("keeps cited guidance separate from recorded dates under the current location", () => {
    const plantId = testShortcode("plant", "basil");
    const planting = fromPartial<PlantingOut>({
      id: testShortcode("planting", "basil"),
      plantId,
      displayName: "Example basil",
      status: "growing",
      locationId: testShortcode("location", "planter"),
      locationName: "Example planter",
      plannedWindow: null,
      sowedOn: "2026-05-01",
      transplantedOn: null,
      expectedHarvestStart: null,
      expectedHarvestEnd: null,
      finishedOn: null,
    });
    const rows = plantingScheduleRows(
      [planting],
      2026,
      new Map([[plantId, "basil"]]),
    );
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["Example planter", 0],
      ["Example basil", 1],
      ["Guide: Basil", 1],
      [expect.stringContaining("Sloat Garden Center"), 2],
    ]);
    expect(rows[1]?.segments[0]?.variant).toBe("milestone");
    expect(rows[3]?.segments[0]?.variant).toBe("reference");
  });
});
