import { describe, it, expect, beforeAll } from "vitest";
import {
  calculateInventoryValue,
  emptyPricingStatus,
  mergePricingStatus,
  formatPricingStatusSummary,
  type InventoryItem,
  type PricingStatus,
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
      category: null,
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

  it("categorizes misc: products as miscNoPrice instead of missingPricing", async () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i5",
        amount: { value: 1, unit: "each" },
        product: {
          id: "p5",
          name: "misc: random screws", // misc: prefix
          manufacturer: "Unknown",
          unitMappings: [], // No price mapping
        },
      }),
      makeInventoryItem({
        id: "i6",
        amount: { value: 1, unit: "each" },
        product: {
          id: "p6",
          name: "Regular Product", // No misc: prefix
          manufacturer: "Unknown",
          unitMappings: [], // No price mapping
        },
      }),
    ];

    const res = await calculateInventoryValue(items);
    expect(res.totalValue).toBe(0);
    // misc: product goes to miscNoPrice
    expect(res.pricingStatus.miscNoPrice.count).toBe(1);
    expect(res.pricingStatus.miscNoPrice.itemNames).toContain(
      "misc: random screws",
    );
    // Regular product without pricing goes to missingPricing
    expect(res.pricingStatus.missingPricing.count).toBe(1);
    expect(res.pricingStatus.missingPricing.itemNames).toContain(
      "Regular Product",
    );
  });
});

describe("emptyPricingStatus", () => {
  it("creates an empty pricing status with zero counts", () => {
    const status = emptyPricingStatus();
    expect(status.priced).toEqual({ count: 0, itemNames: [] });
    expect(status.missingPricing).toEqual({ count: 0, itemNames: [] });
    expect(status.miscNoPrice).toEqual({ count: 0, itemNames: [] });
  });
});

describe("mergePricingStatus", () => {
  const testCases: Array<{
    name: string;
    input: PricingStatus[];
    expected: { priced: number; missing: number; misc: number };
  }> = [
    {
      name: "empty array",
      input: [],
      expected: { priced: 0, missing: 0, misc: 0 },
    },
    {
      name: "single status",
      input: [
        {
          priced: { count: 5, itemNames: ["X"] },
          missingPricing: { count: 2, itemNames: ["Y", "Z"] },
          miscNoPrice: { count: 1, itemNames: ["W"] },
        },
      ],
      expected: { priced: 5, missing: 2, misc: 1 },
    },
    {
      name: "multiple statuses",
      input: [
        {
          priced: { count: 2, itemNames: ["A", "B"] },
          missingPricing: { count: 1, itemNames: ["C"] },
          miscNoPrice: { count: 0, itemNames: [] },
        },
        {
          priced: { count: 1, itemNames: ["D"] },
          missingPricing: { count: 0, itemNames: [] },
          miscNoPrice: { count: 2, itemNames: ["E", "F"] },
        },
      ],
      expected: { priced: 3, missing: 1, misc: 2 },
    },
  ];

  it.each(testCases)("$name", ({ input, expected }) => {
    const merged = mergePricingStatus(input);
    expect(merged.priced.count).toBe(expected.priced);
    expect(merged.missingPricing.count).toBe(expected.missing);
    expect(merged.miscNoPrice.count).toBe(expected.misc);
  });
});

describe("formatPricingStatusSummary", () => {
  const testCases: Array<{
    name: string;
    missing: number;
    misc: number;
    expected: string | null;
  }> = [
    { name: "all priced", missing: 0, misc: 0, expected: null },
    { name: "missing only", missing: 3, misc: 0, expected: "no pricing for 3" },
    { name: "misc only", missing: 0, misc: 2, expected: "2 misc" },
    { name: "both", missing: 3, misc: 2, expected: "no pricing for 3, 2 misc" },
  ];

  it.each(testCases)("$name", ({ missing, misc, expected }) => {
    const status: PricingStatus = {
      priced: { count: 5, itemNames: [] },
      missingPricing: { count: missing, itemNames: [] },
      miscNoPrice: { count: misc, itemNames: [] },
    };
    expect(formatPricingStatusSummary(status)).toBe(expected);
  });
});
