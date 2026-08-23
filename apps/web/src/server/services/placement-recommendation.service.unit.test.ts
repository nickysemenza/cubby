import { describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

const mocks = vi.hoisted(() => ({
  entry: vi.fn(),
  stockRows: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("~/server/repo/inventory", () => ({
  getInventoryEntryByShortcode: mocks.entry,
  getProductStockRows: mocks.stockRows,
}));
vi.mock("~/server/repo/shortcode-resolver", () => ({
  resolveOrThrow: mocks.resolve,
}));

import { getPlacementRecommendation } from "./placement-recommendation.service";

describe("getPlacementRecommendation", () => {
  it("offers only the sole existing stock location for an Unknown row", async () => {
    mocks.entry.mockResolvedValue({
      id: "INV-PARKED",
      placement: "stock",
      product: { id: "PRD-ONE", name: "Widget" },
      location: { id: "LOC-UNKNOWN", name: "Unknown" },
    });
    mocks.resolve.mockResolvedValue("00000000-0000-4000-8000-000000000001");
    mocks.stockRows.mockResolvedValue([
      { id: "INV-PARKED", location: { id: "LOC-UNKNOWN", name: "Unknown" } },
      { id: "INV-FILED", location: { id: "LOC-SHELF", name: "Shelf" } },
    ]);

    await expect(
      getPlacementRecommendation({} as Database, "INV-PARKED" as never),
    ).resolves.toEqual({
      inventoryId: "INV-PARKED",
      productName: "Widget",
      sourceLocation: { id: "LOC-UNKNOWN", name: "Unknown" },
      destination: { id: "LOC-SHELF", name: "Shelf" },
    });
  });

  it("does not invent a destination when several stock locations exist", async () => {
    mocks.entry.mockResolvedValue({
      id: "INV-PARKED",
      placement: "stock",
      product: { id: "PRD-ONE", name: "Widget" },
      location: { id: "LOC-UNKNOWN", name: "Unknown" },
    });
    mocks.resolve.mockResolvedValue("00000000-0000-4000-8000-000000000001");
    mocks.stockRows.mockResolvedValue([
      { id: "INV-FILED-ONE", location: { id: "LOC-ONE", name: "Shelf" } },
      { id: "INV-FILED-TWO", location: { id: "LOC-TWO", name: "Drawer" } },
    ]);

    await expect(
      getPlacementRecommendation({} as Database, "INV-PARKED" as never),
    ).resolves.toBeNull();
  });
});
