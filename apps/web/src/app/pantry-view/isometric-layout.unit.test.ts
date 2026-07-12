import type { InfLocation } from "@cubby/schemas/location";
import { describe, expect, it, vi } from "vitest";
import { buildRooms, type InventoryData } from "./isometric-layout";

describe("isometric pantry layout", () => {
  it("builds deterministic rooms while keeping CSS resolution outside layout", () => {
    const shelf = {
      id: "shelf-1",
      name: "Shelf",
      type: "shelf",
      children: [],
    } as unknown as InfLocation;
    const room = {
      id: "room-1",
      name: "Pantry",
      type: "room",
      children: [shelf],
    } as unknown as InfLocation;
    const inventory: InventoryData[] = [
      {
        id: "inventory-1",
        amount: { value: 2, unit: "each" },
        valuation: 8,
        product: { name: "Coffee", category: "food" },
        location: { id: shelf.id, name: shelf.name, type: shelf.type },
      },
    ];
    const resolveColor = vi.fn((color: string) => `resolved:${color}`);

    const rooms = buildRooms([room], inventory, resolveColor);

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ name: "Pantry", totalItemCount: 1 });
    expect(rooms[0]?.pieces[0]).toMatchObject({
      name: "Shelf",
      locationId: "shelf-1",
      totalValuation: 8,
      items: [{ productName: "Coffee", amount: "2 each" }],
    });
    expect(resolveColor).toHaveBeenCalled();
  });
});
