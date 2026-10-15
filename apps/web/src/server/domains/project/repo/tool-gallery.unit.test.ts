import type { ToolGalleryInventoryEntryOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { toolGalleryGroup, toolGallerySearchText } from "./tool-gallery";

const entry = (
  id: string,
  name: string,
  ancestors: string[] = [],
): ToolGalleryInventoryEntryOut => ({
  id: testShortcode("inventory", id),
  amount: { value: 1, unit: "each" },
  placement: "stock",
  location: {
    id: testShortcode("location", id),
    name,
    ancestors: ancestors.map((ancestor, index) => ({
      id: testShortcode("location", `${id}-${index}`),
      name: ancestor,
      type: index === 0 ? "house" : "room",
    })),
  },
});

describe("tool gallery derivations", () => {
  it("groups a single placement under its first household area", () => {
    expect(
      toolGalleryGroup(
        {
          inventoryEntries: [entry("cabinet", "Cabinet", ["Home", "Garage"])],
          manufacturer: "Makita",
          trade: "cabinetry",
        },
        "location",
      ),
    ).toEqual({
      key: testShortcode("location", "cabinet-1"),
      label: "Garage",
    });
  });

  it("reserves truthful terminal groups for multiple and missing values", () => {
    expect(
      toolGalleryGroup(
        {
          inventoryEntries: [entry("garage", "Garage"), entry("shed", "Shed")],
          manufacturer: "Makita",
          trade: "cabinetry",
        },
        "location",
      ),
    ).toEqual({
      key: "__multiple_locations__",
      label: "Multiple locations",
    });
    expect(
      toolGalleryGroup(
        {
          inventoryEntries: [entry("garage", "Garage")],
          manufacturer: "(UNSPECIFIED)",
          trade: null,
        },
        "manufacturer",
      ),
    ).toEqual({ key: "", label: "Unspecified" });
    expect(
      toolGalleryGroup(
        {
          inventoryEntries: [entry("garage", "Garage")],
          manufacturer: "Makita",
          trade: null,
        },
        "trade",
      ),
    ).toEqual({ key: "", label: "Unclassified" });
  });

  it("normalizes every promised search field", () => {
    const text = toolGallerySearchText({
      productName: "CORDLESS Drill",
      aliases: ["Impact Driver"],
      tags: ["18V"],
      manufacturer: "Makita",
      model: "XFD10",
      inventoryEntries: [entry("cabinet", "Cabinet", ["Home", "Garage"])],
      groupLabel: "Multiple locations",
    });

    for (const term of [
      "cordless drill",
      "impact driver",
      "18v",
      "makita",
      "xfd10",
      "home garage cabinet",
      "multiple locations",
    ]) {
      expect(text).toContain(term);
    }
  });
});
