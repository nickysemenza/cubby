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
  flattenAuditableLocations,
  flattenPickerTree,
  getDirectChildLocations,
  getSessionRootCandidates,
  getUnknownChildLocations,
  isAuditableLocation,
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
    shortcode: unsafeLocationShortcode(`L-${id.slice(0, 4).toUpperCase()}`),
    name,
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
  it("treats precise storage nodes as auditable", () => {
    expect(isAuditableLocation("room")).toBe(true);
    expect(isAuditableLocation("area")).toBe(true);
    expect(isAuditableLocation("shelf")).toBe(true);
    expect(isAuditableLocation("tote-bin")).toBe(true);
    expect(isAuditableLocation("drawer")).toBe(true);
  });

  it("flattens auditable descendants at any depth", () => {
    const bin = loc(
      "00000000-0000-4000-8000-000000000004",
      "Bin A",
      "tote-bin",
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

  it("selects useful session roots and excludes global Unknown", () => {
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
      ...loc("00000000-0000-4000-8000-000000000032", "Tote", "tote-bin"),
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
