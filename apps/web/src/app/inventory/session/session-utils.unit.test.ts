import {
  unsafeLocationId,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { describe, expect, it } from "vitest";
import {
  buildBulkMovePayloadItems,
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
    id: unsafeLocationId(id),
    // Fixtures share a "00000000-0000-4000-8000-..." prefix, so the shortcode
    // must key off the varying tail, not the head, to stay unique per id.
    shortcode: unsafeLocationShortcode(`L-${id.slice(-4).toUpperCase()}`),
    name,
    aliases: [],
    type,
    lastBulkInventory: null,
    aiDescription: null,
    images: [],
    valuation: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    children,
  };
}

describe("inventory session utils", () => {
  it("flattens every descendant at any depth", () => {
    const bin = loc(
      "00000000-0000-4000-8000-000000000004",
      "Bin A",
      "tote-27gal",
    );
    const shelf = loc(
      "00000000-0000-4000-8000-000000000003",
      "Shelf 1",
      "shelf",
      [bin],
    );
    const area = loc(
      "00000000-0000-4000-8000-000000000002",
      "North Wall",
      "area",
      [shelf],
    );
    const garage = loc(
      "00000000-0000-4000-8000-000000000001",
      "Garage",
      "room",
      [area],
    );

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
      findLocationInTreeByShortcode([garage, pantry], drawer.shortcode)?.name,
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
      ...loc("00000000-0000-4000-8000-000000000032", "Tote", "tote-27gal"),
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

  it("offers global Unknown as a root once it holds items", () => {
    // Recounting Unknown is the drain: each row gets relocated to where it
    // belongs. An Unknown holding only empty child locations stays hidden.
    const emptyUnknown = {
      ...loc("00000000-0000-4000-8000-000000000060", "Unknown", "area", [
        loc("00000000-0000-4000-8000-000000000061", "Parked bin", "tote-27gal"),
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
      ...loc("00000000-0000-4000-8000-000000000053", "Paint Crate", "crate"),
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
        searchTerm: "crate",
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
});
