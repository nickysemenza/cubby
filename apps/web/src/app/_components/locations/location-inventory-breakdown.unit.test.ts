import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  buildLocationInventoryBreakdown,
  hasDescendantInventory,
} from "./location-inventory-breakdown";

describe("buildLocationInventoryBreakdown", () => {
  it("keeps direct stock distinct from descendant totals", () => {
    const tree = buildLocationInventoryBreakdown({
      id: unsafeLocationShortcode("LOC-GAR1"),
      name: "Garage",
      type: "room",
      directItemCount: 2,
      totalItemCount: 7,
      children: [
        {
          id: unsafeLocationShortcode("LOC-AREA"),
          name: "Area 1",
          type: "area",
          directItemCount: 5,
          totalItemCount: 5,
          children: [],
        },
      ],
    });

    expect(tree).toMatchObject({
      label: "Garage",
      metricLabel: "7 items",
      metricValue: 7,
      directMetricLabel: "2 items",
      directMetricValue: 2,
    });
    expect(tree.children).toEqual([
      expect.objectContaining({
        label: "Area 1",
        metricLabel: "5 items",
        directMetricLabel: "5 items",
      }),
    ]);
  });

  it("does not invent a direct contribution for a purely structural location", () => {
    const tree = buildLocationInventoryBreakdown({
      id: unsafeLocationShortcode("LOC-HOME"),
      name: "Home",
      type: "area",
      directItemCount: 0,
      totalItemCount: 1,
      children: [],
    });

    expect(tree.directMetricLabel).toBeUndefined();
    expect(tree.metricLabel).toBe("1 item");
  });

  it("only exposes the drill-down when a child holds stock", () => {
    const directOnly = {
      id: unsafeLocationShortcode("LOC-DIRC"),
      name: "Garage",
      type: "room" as const,
      directItemCount: 2,
      totalItemCount: 2,
      children: [],
    };

    expect(hasDescendantInventory(undefined)).toBe(false);
    expect(hasDescendantInventory(directOnly)).toBe(false);
    expect(
      hasDescendantInventory({
        ...directOnly,
        totalItemCount: 3,
      }),
    ).toBe(true);
  });
});
