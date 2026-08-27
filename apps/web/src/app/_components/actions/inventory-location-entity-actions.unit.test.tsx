import { testShortcode } from "@cubby/schemas/testing";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { inventoryLocationEntityActionDefinitions } from "./inventory-location-entity-actions";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("../inventory/move-inventory-dialog", () => ({
  MoveInventoryDialog: () => null,
}));
vi.mock("../locations/bulk-reparent-locations-dialog", () => ({
  BulkReparentLocationsDialog: () => null,
}));

const completeInventoryRow = {
  id: testShortcode("inventory", "INV-ABC1"),
  amount: { value: 2, unit: "each" },
  location: { id: testShortcode("location", "LOC-GAR1"), name: "Garage" },
  product: { name: "Widget" },
};

describe("inventory and location action catalog", () => {
  it("keeps inventory move staged only for complete payloads", async () => {
    const definition = inventoryLocationEntityActionDefinitions[0];
    const { result } = renderHook(() => definition.use());
    const run = result.current.run;
    expect(run).not.toBeNull();
    if (!run) throw new Error("Inventory Move must expose a runner");

    await expect(run([{ id: completeInventoryRow.id }])).resolves.toEqual({
      success: false,
    });
    let staged: Promise<{ success: boolean }> | undefined;
    act(() => {
      staged = run([completeInventoryRow]);
    });
    expect(staged).toBeDefined();
  });

  it("disables mixed location label selections instead of filtering them", () => {
    const definition = inventoryLocationEntityActionDefinitions[1];
    const { result } = renderHook(() => definition.use());
    const room = {
      id: testShortcode("location", "LOC-ROM1"),
      type: "room" as const,
      name: "Room",
      aliases: [],
      product: null,
      lastBulkInventory: null,
      aiDescription: null,
      images: [],
      valuation: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    const shelf = {
      ...room,
      id: testShortcode("location", "LOC-SHF1"),
      type: "shelf" as const,
      name: "Shelf",
    };
    expect(
      result.current.availability?.({
        entity: "location",
        surface: "selection",
        rows: [room, shelf],
      }),
    ).toEqual({
      status: "disabled",
      reason: "Rooms and areas do not support QR labels.",
    });
  });

  it("keeps the declared surfaces and catalog order stable", () => {
    expect(
      inventoryLocationEntityActionDefinitions.map(({ id }) => id),
    ).toEqual([
      "move-inventory",
      "print-location-labels",
      "move-location-under",
    ]);
    expect(inventoryLocationEntityActionDefinitions[0]).toMatchObject({
      entities: ["inventory"],
      surfaces: ["row", "selection", "inspector", "detail"],
    });
    expect(inventoryLocationEntityActionDefinitions[1]).toMatchObject({
      entities: ["location"],
      surfaces: ["row", "selection", "inspector", "detail"],
    });
  });
});
