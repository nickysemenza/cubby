import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  buildBulkMovePayloadItems,
  classifyScannedLocation,
  confirmationKey,
  findLocationInTree,
  findLocationInTreeByShortcode,
  flattenAuditableLocations,
  flattenPickerTree,
  getDirectChildLocations,
  getSessionRootCandidates,
  getUnknownChildLocations,
  isDescendantLocation,
} from "./session-utils";

function loc(
  id: string,
  name: string,
  type: LocationType,
  children: InfLocation[] = [],
): InfLocation {
  return {
    id: testShortcode("location", `LOC-${id.slice(-4).toUpperCase()}`),
    // Fixtures share a "00000000-0000-4000-8000-..." prefix, so the shortcode
    // must key off the varying tail, not the head, to stay unique per id.
    name,
    aliases: [],
    product: null,
    type,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    dataQuality: testCompleteDataQuality(),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    children,
  };
}

describe("inventory session utils", () => {
  it("flattens stocked descendants at any depth", () => {
    const bin = {
      ...loc("00000000-0000-4000-8000-000000000004", "Bin A", "box"),
      directItemCount: 1,
      totalItemCount: 1,
    };
    const shelf = {
      ...loc("00000000-0000-4000-8000-000000000003", "Shelf 1", "shelf", [bin]),
      directItemCount: 1,
      totalItemCount: 2,
    };
    const area = {
      ...loc("00000000-0000-4000-8000-000000000002", "North Wall", "area", [
        shelf,
      ]),
      directItemCount: 1,
      totalItemCount: 3,
    };
    const garage = {
      ...loc("00000000-0000-4000-8000-000000000001", "Garage", "room", [area]),
      directItemCount: 1,
      totalItemCount: 4,
    };

    const flattened = flattenAuditableLocations(garage);

    expect(flattened.map((item) => item.name)).toEqual([
      "Garage",
      "North Wall",
      "Shelf 1",
      "Bin A",
    ]);
    expect(flattened[3]?.path).toEqual([
      "Garage",
      "North Wall",
      "Shelf 1",
      "Bin A",
    ]);
  });

  it("omits empty descendants from a recount sweep", () => {
    const emptyBin = loc(
      "00000000-0000-4000-8000-000000000104",
      "Empty Bin",
      "box",
    );
    const stockedBin = {
      ...loc("00000000-0000-4000-8000-000000000103", "Stocked Bin", "box"),
      directItemCount: 2,
      totalItemCount: 2,
    };
    const emptyShelf = {
      ...loc("00000000-0000-4000-8000-000000000102", "Empty Shelf", "shelf", [
        emptyBin,
      ]),
      totalItemCount: 0,
    };
    const garage = {
      ...loc("00000000-0000-4000-8000-000000000101", "Garage", "room", [
        stockedBin,
        emptyShelf,
      ]),
      directItemCount: 1,
      totalItemCount: 3,
    };

    expect(
      flattenAuditableLocations(garage).map((location) => location.name),
    ).toEqual(["Garage", "Stocked Bin"]);
  });

  it("finds locations and recognizes descendants", () => {
    const drawer = loc(
      "00000000-0000-4000-8000-000000000012",
      "Drawer",
      "drawer",
    );
    const cabinet = loc(
      "00000000-0000-4000-8000-000000000011",
      "Cabinet",
      "cabinet",
      [drawer],
    );
    const garage = loc(
      "00000000-0000-4000-8000-000000000010",
      "Garage",
      "room",
      [cabinet],
    );
    const pantry = loc(
      "00000000-0000-4000-8000-000000000020",
      "Pantry",
      "room",
    );

    expect(findLocationInTree([garage, pantry], drawer.id)?.name).toBe(
      "Drawer",
    );
    expect(isDescendantLocation(garage, garage.id)).toBe(true);
    expect(isDescendantLocation(garage, drawer.id)).toBe(true);
    expect(isDescendantLocation(garage, pantry.id)).toBe(false);
  });

  it("finds locations by shortcode", () => {
    const drawer = loc(
      "00000000-0000-4000-8000-000000000012",
      "Drawer",
      "drawer",
    );
    const cabinet = loc(
      "00000000-0000-4000-8000-000000000011",
      "Cabinet",
      "cabinet",
      [drawer],
    );
    const garage = loc(
      "00000000-0000-4000-8000-000000000010",
      "Garage",
      "room",
      [cabinet],
    );
    const pantry = loc(
      "00000000-0000-4000-8000-000000000020",
      "Pantry",
      "room",
    );

    expect(
      findLocationInTreeByShortcode([garage, pantry], drawer.id)?.name,
    ).toBe("Drawer");
    expect(
      findLocationInTreeByShortcode([garage, pantry], undefined),
    ).toBeNull();
    expect(
      findLocationInTreeByShortcode([garage, pantry], "L-NOPE"),
    ).toBeNull();
  });

  it("selects useful session roots and excludes an empty global Unknown", () => {
    const unknown = loc(
      "00000000-0000-4000-8000-000000000030",
      "Unknown",
      "room",
    );
    const emptyShelf = loc(
      "00000000-0000-4000-8000-000000000031",
      "Empty Shelf",
      "shelf",
    );
    const tote = {
      ...loc("00000000-0000-4000-8000-000000000032", "Tote", "box"),
      directItemCount: 2,
      totalItemCount: 2,
    };
    const garage = {
      ...loc("00000000-0000-4000-8000-000000000033", "Garage", "room", [tote]),
      totalItemCount: 2,
    };

    expect(
      getSessionRootCandidates([emptyShelf, tote, unknown, garage]).map(
        (item) => item.name,
      ),
    ).toEqual(["Garage", "Tote"]);
  });

  it("offers global Unknown as a session scope once it holds items", () => {
    // Recounting Unknown is the drain: each row gets relocated to where it
    // belongs. An Unknown holding only empty child locations stays hidden.
    const emptyUnknown = {
      ...loc("00000000-0000-4000-8000-000000000060", "Unknown", "area", [
        loc("00000000-0000-4000-8000-000000000061", "Parked bin", "box"),
      ]),
    };
    const stockedUnknown = {
      ...loc("00000000-0000-4000-8000-000000000062", "Unknown", "area"),
      directItemCount: 3,
      totalItemCount: 3,
    };

    expect(getSessionRootCandidates([emptyUnknown]).map((i) => i.name)).toEqual(
      [],
    );
    expect(
      getSessionRootCandidates([stockedUnknown]).map((i) => i.name),
    ).toEqual(["Unknown"]);
  });

  it("flattens picker roots with expansion and search", () => {
    const crate = {
      ...loc("00000000-0000-4000-8000-000000000053", "Paint Crate", "box"),
      directItemCount: 1,
      totalItemCount: 1,
    };
    const shelf = {
      ...loc("00000000-0000-4000-8000-000000000052", "Paint Shelf", "shelf", [
        crate,
      ]),
      totalItemCount: 1,
    };
    const garage = {
      ...loc("00000000-0000-4000-8000-000000000051", "Garage", "room", [shelf]),
      totalItemCount: 1,
    };
    const candidateIds = new Set(
      getSessionRootCandidates([garage, shelf, crate]).map((item) => item.id),
    );

    expect(
      flattenPickerTree([garage], candidateIds, {
        expandedIds: new Set([garage.id]),
      }).map((row) => row.location.name),
    ).toEqual(["Garage", "Paint Shelf"]);

    expect(
      flattenPickerTree([garage], candidateIds, {
        expandedIds: new Set(),
      }).map((row) => row.location.name),
    ).toEqual(["Garage"]);

    expect(
      flattenPickerTree([garage], candidateIds, {
        searchTerm: "box",
      }).map((row) => row.location.name),
    ).toEqual(["Garage", "Paint Shelf", "Paint Crate"]);
  });

  it("extracts direct child and unknown child locations", () => {
    const drawer = loc(
      "00000000-0000-4000-8000-000000000041",
      "Drawer",
      "drawer",
    );
    const cabinet = loc(
      "00000000-0000-4000-8000-000000000042",
      "Cabinet",
      "cabinet",
      [drawer],
    );
    const unknown = loc(
      "00000000-0000-4000-8000-000000000043",
      "Unknown",
      "room",
      [cabinet],
    );

    expect(getDirectChildLocations(cabinet)).toEqual([drawer]);
    expect(getUnknownChildLocations(unknown)).toEqual([cabinet]);
    expect(getUnknownChildLocations(null)).toEqual([]);
  });

  it("builds stable confirmation keys and bulk move payloads", () => {
    expect(confirmationKey("location", "abc")).toBe("location:abc");
    expect(
      buildBulkMovePayloadItems([
        { id: "inv-1", amount: { value: 2, unit: "each" } },
      ]),
    ).toEqual([
      {
        inventoryEntryId: "inv-1",
        quantity: { value: 2, unit: "each" },
      },
    ]);
  });

  // The bin-QR outcomes classify by TREE POSITION, not pass membership. A bin
  // carried into another room is usually still inside the recount root, so
  // classifying by "is it a stop" would call it a jump and lose the adopt case.
  describe("classifyScannedLocation", () => {
    const drawer = loc("...0001", "Drawer", "box");
    const shelf = loc("...0002", "Shelf", "shelf", [drawer]);
    const strayBin = loc("...0003", "Stray bin", "box");
    const garage = loc("...0004", "Garage", "room", [strayBin]);
    const house = loc("...0005", "House", "room", [shelf, garage]);

    it("names the bin you are already standing at", () => {
      expect(classifyScannedLocation(house, shelf, shelf.id)).toBe("current");
    });

    it("treats something already inside the current bin as nothing to adopt", () => {
      expect(classifyScannedLocation(house, shelf, drawer.id)).toBe("inside");
    });

    it("refuses an ancestor, which would make a cycle", () => {
      expect(classifyScannedLocation(house, shelf, house.id)).toBe("ancestor");
    });

    it("offers to adopt a bin sitting elsewhere in the same tree", () => {
      expect(classifyScannedLocation(house, shelf, strayBin.id)).toBe(
        "elsewhere",
      );
    });

    it("offers to adopt a sibling branch, not just a leaf", () => {
      expect(classifyScannedLocation(house, shelf, garage.id)).toBe(
        "elsewhere",
      );
    });
  });
});
