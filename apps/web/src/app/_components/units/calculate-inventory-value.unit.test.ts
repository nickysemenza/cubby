import { describe, it, expect, beforeAll } from "vitest";
import {
  calculateInventoryValue,
  type InventoryItem,
} from "../locations/calculate-inventory-value";
import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "~/schemas/identifiers";
import { ensureWasm } from "~/lib/wasm";

// Initialize WASM before tests run
beforeAll(async () => {
  await ensureWasm();
});

function makeInventoryItem(params: {
  id: string;
  product: {
    id: string;
    name: string;
    manufacturer?: string;
    unitMappings: Array<{
      a: { value: number; unit: string };
      b: { value: number; unit: string };
    }>;
  };
  amount: { value: number; unit: string };
}): InventoryItem {
  const now = new Date();
  return {
    id: unsafeInventoryId(params.id),
    createdAt: now,
    updatedAt: now,
    amount: params.amount,
    location: {
      id: unsafeLocationId("loc-1"),
      name: "Test Location",
      type: "room",
      images: [],
      createdAt: now,
      updatedAt: now,
      lastBulkInventory: null,
    },
    product: {
      id: unsafeProductId(params.product.id),
      name: params.product.name,
      manufacturer: params.product.manufacturer ?? "Generic",
      model: null,
      upc: null,
      ndb_number: null,
      expectedQuantity: null,
      images: [],
      createdAt: now,
      updatedAt: now,
      unitMappings: params.product.unitMappings.map((m, idx) => ({
        id: `${params.id}-um-${idx}`,
        a: m.a,
        b: m.b,
        source: "test",
        sourceMetadata: { type: "manual" as const },
        createdAt: now,
        updatedAt: now,
      })),
    },
  };
}

describe("calculateInventoryValue", () => {
  it("sums totals across products using price mappings", async () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i1",
        amount: { value: 2, unit: "lb" },
        product: {
          id: "p1",
          name: "Flour",
          manufacturer: "BrandA",
          unitMappings: [
            { a: { value: 1, unit: "lb" }, b: { value: 5, unit: "dollar" } },
          ],
        },
      }),
      makeInventoryItem({
        id: "i2",
        amount: { value: 3, unit: "each" },
        product: {
          id: "p2",
          name: "Eggs",
          manufacturer: "BrandB",
          unitMappings: [
            { a: { value: 1, unit: "each" }, b: { value: 3, unit: "dollar" } },
          ],
        },
      }),
    ];

    const res = await calculateInventoryValue(items);
    expect(res.totalValue).toBe(2 * 5 + 3 * 3); // 19
    expect(res.breakdown.find((b) => b.key === "BrandA")?.value).toBe(10);
    expect(res.breakdown.find((b) => b.key === "BrandB")?.value).toBe(9);
    expect(res.pricingStatus.missingPricing.count).toBe(0);
    expect(res.pricingStatus.priced.count).toBe(2);
  });

  it("handles missing price mappings gracefully", async () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i3",
        amount: { value: 1, unit: "lb" },
        product: {
          id: "p3",
          name: "Sugar",
          manufacturer: "BrandC",
          unitMappings: [
            // No money mapping; only weight mapping example
            { a: { value: 1, unit: "lb" }, b: { value: 454, unit: "g" } },
          ],
        },
      }),
    ];

    const res = await calculateInventoryValue(items);
    expect(res.totalValue).toBe(0);
    expect(res.pricingStatus.missingPricing.itemNames).toContain("Sugar");
    expect(res.pricingStatus.missingPricing.count).toBe(1);
  });

  it("handles chained conversions via intermediate units to money", async () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i4",
        amount: { value: 2, unit: "Pound" },
        product: {
          id: "p4",
          name: "Rice",
          manufacturer: "BrandChain",
          unitMappings: [
            // Pound -> Gram
            {
              a: { value: 1, unit: "Pound" },
              b: { value: 453.59, unit: "Gram" },
            },
            // Gram -> Dollar (per 100g)
            {
              a: { value: 100, unit: "Gram" },
              b: { value: 1.5, unit: "Dollar" },
            },
          ],
        },
      }),
    ];

    const res = await calculateInventoryValue(items);
    const expected = 2 * 453.59 * (1.5 / 100); // 2 lb -> g -> $ per 100g
    expect(res.totalValue).toBeCloseTo(expected, 1);
    expect(
      res.breakdown.find((b) => b.key === "BrandChain")?.value,
    ).toBeCloseTo(expected, 2);
  });
});
