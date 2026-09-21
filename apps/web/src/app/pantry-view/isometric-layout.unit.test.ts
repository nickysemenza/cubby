import { type InfLocation, infLocation } from "@cubby/schemas/location";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";

import { categorySummaryFixture } from "../../../tooling/product-category-fixtures";
import { buildRooms, type InventoryData } from "./isometric-layout";

describe("isometric pantry layout", () => {
  const location = (
    id: string,
    name: string,
    type: "room" | "shelf" | null,
    children: InfLocation[] = [],
  ) =>
    infLocation.parse({
      id: testShortcode("location", id),
      name,
      aliases: [],
      type,
      product: null,
      lastBulkInventory: null,
      aiDescription: null,
      notes: null,
      images: [],
      valuation: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      children,
    });

  it("draws a product-linked location as a floor container, not a wall shelf", () => {
    // A location that IS a Product carries no `type`. Falling through to the
    // switch default would size it as a 3.8ft back-wall shelving unit, which is
    // what ~82 of the 107 linked locations (crates, totes, packout boxes) are
    // decidedly not.
    const tote = location("tote-1", "party lighting", null);
    const room = location("room-1", "Garage", "room", [tote]);

    // Contents are required: `buildRooms` skips a subtree whose pieces are all
    // empty, so a bin with nothing in it never reaches the canvas anyway.
    const inventory: InventoryData[] = [
      {
        id: "inventory-1",
        amount: { value: 1, unit: "each" },
        valuation: 20,
        product: {
          name: "String lights",
          category: categorySummaryFixture("household"),
        },
        location: { id: tote.id, name: tote.name, type: null },
      },
    ];

    const rooms = buildRooms([room], inventory, (c: string) => c);
    const piece = rooms[0]?.pieces[0];

    expect(piece).toMatchObject({ name: "party lighting", locationType: null });
    // The box spec — floor-standing and short, not the 3.8 back-wall default.
    expect(piece?.h).toBe(1.2);
    expect(piece?.shelfLevels).toEqual([0.1]);
  });

  it("builds deterministic rooms while keeping CSS resolution outside layout", () => {
    const shelf = location("shelf-1", "Shelf", "shelf");
    const room = location("room-1", "Pantry", "room", [shelf]);
    const inventory: InventoryData[] = [
      {
        id: "inventory-1",
        amount: { value: 2, unit: "each" },
        valuation: 8,
        product: { name: "Coffee", category: categorySummaryFixture("food") },
        location: { id: shelf.id, name: shelf.name, type: shelf.type },
      },
    ];
    const resolveColor = vi.fn((color: string) => `resolved:${color}`);

    const rooms = buildRooms([room], inventory, resolveColor);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ name: "Pantry", totalItemCount: 1 });
    expect(rooms[0]?.pieces[0]).toMatchObject({
      name: "Shelf",
      locationId: shelf.id,
      totalValuation: 8,
      items: [{ productName: "Coffee", amount: "2 each" }],
    });
    expect(resolveColor).toHaveBeenCalled();
  });
});
