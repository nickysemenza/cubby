import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import {
  calculateInventoryValuation,
  emptyPricingStatus,
  formatPricingStatusSummary,
  type InventoryItem,
  mergePricingStatus,
  type PricingStatus,
} from "./calculate-inventory-valuation";

function makeInventoryItem(params: {
  id: string;
  product: {
    id: string;
    name: string;
    manufacturer?: string;
  };
  valuation: number | null;
}): InventoryItem {
  const now = new Date();
  return {
    id: unsafeInventoryId(params.id),
    createdAt: now,
    updatedAt: now,
    amount: { value: 1, unit: "each" },
    valuation: params.valuation,
    location: {
      id: unsafeLocationId("loc-1"),
      shortcode: unsafeLocationShortcode("L-TEST"),
      name: "Test Location",
      type: "room",
      images: [],
      createdAt: now,
      updatedAt: now,
      lastBulkInventory: null,
    },
    product: {
      id: unsafeProductId(params.product.id),
      shortcode: unsafeProductShortcode("P-TEST"),
      name: params.product.name,
      manufacturer: params.product.manufacturer ?? "Generic",
      category: null,
      model: null,
      upc: null,
      ndb_number: null,
      expectedQuantity: null,
      price: null,
      images: [],
      createdAt: now,
      updatedAt: now,
      unitMappings: [],
    },
  };
}

describe("calculateInventoryValuation", () => {
  it("sums precomputed valuation across items", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i1",
        valuation: 10,
        product: { id: "p1", name: "Flour", manufacturer: "BrandA" },
      }),
      makeInventoryItem({
        id: "i2",
        valuation: 9,
        product: { id: "p2", name: "Eggs", manufacturer: "BrandB" },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.totalValuation).toBe(19);
    expect(res.breakdown.find((b) => b.key === "BrandA")?.valuation).toBe(10);
    expect(res.breakdown.find((b) => b.key === "BrandB")?.valuation).toBe(9);
    expect(res.pricingStatus.missingPricing.count).toBe(0);
    expect(res.pricingStatus.priced.count).toBe(2);
  });

  it("handles null valuation gracefully", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i3",
        valuation: null,
        product: { id: "p3", name: "Sugar", manufacturer: "BrandC" },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.totalValuation).toBe(0);
    expect(res.pricingStatus.missingPricing.itemNames).toContain("Sugar");
    expect(res.pricingStatus.missingPricing.count).toBe(1);
  });

  it("handles zero valuation as unpriced", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i4",
        valuation: 0,
        product: { id: "p4", name: "Rice", manufacturer: "BrandD" },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.totalValuation).toBe(0);
    expect(res.pricingStatus.missingPricing.count).toBe(1);
  });

  it("categorizes misc: products as miscNoPrice instead of missingPricing", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i5",
        valuation: null,
        product: {
          id: "p5",
          name: "misc: random screws", // misc: prefix
          manufacturer: "Unknown",
        },
      }),
      makeInventoryItem({
        id: "i6",
        valuation: null,
        product: {
          id: "p6",
          name: "Regular Product", // No misc: prefix
          manufacturer: "Unknown",
        },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.totalValuation).toBe(0);
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

  it("groups breakdown by manufacturer", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i7",
        valuation: 5,
        product: { id: "p7", name: "Item A", manufacturer: "Same" },
      }),
      makeInventoryItem({
        id: "i8",
        valuation: 3,
        product: { id: "p8", name: "Item B", manufacturer: "Same" },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.totalValuation).toBe(8);
    expect(res.breakdown).toHaveLength(1);
    expect(res.breakdown[0]?.key).toBe("Same");
    expect(res.breakdown[0]?.valuation).toBe(8);
  });

  it("uses 'Unknown' for products without manufacturer", () => {
    const items: InventoryItem[] = [
      makeInventoryItem({
        id: "i9",
        valuation: 7,
        product: { id: "p9", name: "Mystery", manufacturer: "" },
      }),
    ];

    const res = calculateInventoryValuation(items);
    expect(res.breakdown.find((b) => b.key === "Unknown")?.valuation).toBe(7);
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
