import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldChange } from "~/schemas/csv";
import type {
  InventoryCSVRow,
  ProductChangesPreview,
} from "~/schemas/inventory";

// Partial row type for tests - we only need to specify fields we're testing
type PartialRow = Partial<InventoryCSVRow>;

// Mock SYNC_TIMESTAMPS before importing the module
vi.mock("~/server/repo/sync/config", () => ({
  SYNC_TIMESTAMPS: true,
}));

// Mock date-utils
vi.mock("~/server/repo/csv/date-utils", () => ({
  parseCSVDate: vi.fn((dateStr: string | null | undefined) => {
    if (!dateStr) return null;
    // Simple mock that returns a Date object for any non-empty string
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }),
}));

// Import after mocks
import {
  addFieldChange,
  buildFieldChanges,
  hasChanges,
  parseRowTimestamps,
  productChangesToFieldChanges,
  wrapChanges,
} from "./row-processor";

describe("addFieldChange", () => {
  it("adds field change when willBeSet is defined", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "name", "new-value", "old-value");

    expect(result).toEqual([
      { field: "name", from: "old-value", to: "new-value" },
    ]);
  });

  it("does not add field change when willBeSet is undefined", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "name", undefined, "old-value");

    expect(result).toEqual([]);
  });

  it("converts null current value to null in from field", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "price", 10.5, null);

    expect(result).toEqual([{ field: "price", from: null, to: 10.5 }]);
  });

  it("converts undefined current value to null in from field", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "model", "ABC123", undefined);

    expect(result).toEqual([{ field: "model", from: null, to: "ABC123" }]);
  });

  it("handles numeric values", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "quantity", 100, 50);

    expect(result).toEqual([{ field: "quantity", from: 50, to: 100 }]);
  });

  it("handles zero as a valid willBeSet value", () => {
    const result: FieldChange[] = [];
    addFieldChange(result, "count", 0, 5);

    expect(result).toEqual([{ field: "count", from: 5, to: 0 }]);
  });
});

describe("hasChanges", () => {
  it("returns false for empty object", () => {
    expect(hasChanges({})).toBe(false);
  });

  it("returns true when object has properties", () => {
    const changes: ProductChangesPreview = {
      priceWillBeSet: 10,
    };
    expect(hasChanges(changes)).toBe(true);
  });

  it("returns true for multiple properties", () => {
    const changes: ProductChangesPreview = {
      priceWillBeSet: 10,
      modelWillBeSet: "ABC",
      upcWillBeSet: "123456789",
    };
    expect(hasChanges(changes)).toBe(true);
  });
});

describe("wrapChanges", () => {
  it("returns undefined for empty object", () => {
    expect(wrapChanges({})).toBeUndefined();
  });

  it("returns the object when it has properties", () => {
    const changes: ProductChangesPreview = {
      priceWillBeSet: 10,
    };
    expect(wrapChanges(changes)).toBe(changes);
  });
});

describe("productChangesToFieldChanges", () => {
  it("returns empty array for empty changes", () => {
    const result = productChangesToFieldChanges({});
    expect(result).toEqual([]);
  });

  it("converts simple field changes", () => {
    const changes: ProductChangesPreview = {
      upcWillBeSet: "123456789",
      upcCurrent: null,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([{ field: "upc", from: null, to: "123456789" }]);
  });

  it("converts model change", () => {
    const changes: ProductChangesPreview = {
      modelWillBeSet: "MODEL-2024",
      modelCurrent: "MODEL-2023",
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([
      { field: "model", from: "MODEL-2023", to: "MODEL-2024" },
    ]);
  });

  it("converts ndb number change", () => {
    const changes: ProductChangesPreview = {
      ndbNumberWillBeSet: 12345,
      ndbNumberCurrent: null,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([{ field: "ndb", from: null, to: 12345 }]);
  });

  it("converts expected quantity change", () => {
    const changes: ProductChangesPreview = {
      expectedQuantityWillBeSet: 10,
      expectedQuantityCurrent: 5,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([{ field: "expected", from: 5, to: 10 }]);
  });

  it("converts price change", () => {
    const changes: ProductChangesPreview = {
      priceWillBeSet: 9.99,
      priceCurrent: 7.99,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([{ field: "price", from: 7.99, to: 9.99 }]);
  });

  it("converts ingredient linking", () => {
    const changes: ProductChangesPreview = {
      ingredientWillBeLinked: "flour",
      ingredientCurrent: null,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([{ field: "ingredient", from: null, to: "flour" }]);
  });

  it("converts unit mappings with details", () => {
    const changes: ProductChangesPreview = {
      unitMappingsWillBeAdded: 2,
      unitMappingsDetail: [
        { from: "1 stick", to: "113.4g" },
        { from: "1 cup", to: "227g" },
      ],
      unitMappingsCurrent: null,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([
      {
        field: "unit_mappings",
        from: null,
        to: "1 stick = 113.4g; 1 cup = 227g",
      },
    ]);
  });

  it("converts unit mappings without details (shows count)", () => {
    const changes: ProductChangesPreview = {
      unitMappingsWillBeAdded: 3,
      unitMappingsCurrent: "1 each = 100g",
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([
      { field: "unit_mappings", from: "1 each = 100g", to: "3 mappings" },
    ]);
  });

  it("skips unit mappings when willBeAdded is 0", () => {
    const changes: ProductChangesPreview = {
      unitMappingsWillBeAdded: 0,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([]);
  });

  it("converts aliases", () => {
    const changes: ProductChangesPreview = {
      aliasesWillBeAdded: ["butter", "unsalted butter"],
      aliasesCurrent: ["margarine"],
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([
      { field: "aliases", from: "margarine", to: "butter; unsalted butter" },
    ]);
  });

  it("handles aliases with no current value", () => {
    const changes: ProductChangesPreview = {
      aliasesWillBeAdded: ["flour", "all-purpose flour"],
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([
      { field: "aliases", from: null, to: "flour; all-purpose flour" },
    ]);
  });

  it("skips aliases when empty array", () => {
    const changes: ProductChangesPreview = {
      aliasesWillBeAdded: [],
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toEqual([]);
  });

  it("combines multiple changes", () => {
    const changes: ProductChangesPreview = {
      upcWillBeSet: "123",
      modelWillBeSet: "ABC",
      priceWillBeSet: 5.99,
    };

    const result = productChangesToFieldChanges(changes);

    expect(result).toHaveLength(3);
    expect(result.find((c) => c.field === "upc")).toBeDefined();
    expect(result.find((c) => c.field === "model")).toBeDefined();
    expect(result.find((c) => c.field === "price")).toBeDefined();
  });
});

describe("buildFieldChanges", () => {
  it("returns undefined when no changes", () => {
    const result = buildFieldChanges({}, undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when both inputs are empty", () => {
    const result = buildFieldChanges({}, []);
    expect(result).toBeUndefined();
  });

  it("returns product changes only when no inventory changes", () => {
    const productChanges: ProductChangesPreview = {
      priceWillBeSet: 10,
    };

    const result = buildFieldChanges(productChanges, undefined);

    expect(result).toEqual([{ field: "price", from: null, to: 10 }]);
  });

  it("returns inventory changes only when no product changes", () => {
    const inventoryChanges: FieldChange[] = [
      { field: "qty", from: "5 lbs", to: "10 lbs" },
    ];

    const result = buildFieldChanges({}, inventoryChanges);

    expect(result).toEqual([{ field: "qty", from: "5 lbs", to: "10 lbs" }]);
  });

  it("combines inventory and product changes", () => {
    const productChanges: ProductChangesPreview = {
      priceWillBeSet: 10,
    };
    const inventoryChanges: FieldChange[] = [
      { field: "qty", from: "5 lbs", to: "10 lbs" },
    ];

    const result = buildFieldChanges(productChanges, inventoryChanges);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      field: "qty",
      from: "5 lbs",
      to: "10 lbs",
    });
    expect(result).toContainEqual({ field: "price", from: null, to: 10 });
  });

  it("puts inventory changes before product changes", () => {
    const productChanges: ProductChangesPreview = {
      priceWillBeSet: 10,
    };
    const inventoryChanges: FieldChange[] = [
      { field: "qty", from: "5 lbs", to: "10 lbs" },
    ];

    const result = buildFieldChanges(productChanges, inventoryChanges);

    expect(result?.[0].field).toBe("qty");
    expect(result?.[1].field).toBe("price");
  });
});

describe("parseRowTimestamps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined timestamps when row has no timestamp fields", () => {
    const row = {
      product_name: "Test Product",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.product).toBeUndefined();
    expect(result.inventory).toBeUndefined();
  });

  it("parses product_created_at", () => {
    const row = {
      product_name: "Test Product",
      product_created_at: "2024-01-15 10:30:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.product).toBeDefined();
    expect(result.product?.createdAt).toBeInstanceOf(Date);
  });

  it("parses product_updated_at", () => {
    const row = {
      product_name: "Test Product",
      product_updated_at: "2024-01-15 10:30:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.product).toBeDefined();
    expect(result.product?.updatedAt).toBeInstanceOf(Date);
  });

  it("parses inventory_created_at", () => {
    const row = {
      product_name: "Test Product",
      inventory_created_at: "2024-01-15 10:30:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.inventory).toBeDefined();
    expect(result.inventory?.createdAt).toBeInstanceOf(Date);
  });

  it("parses inventory_updated_at", () => {
    const row = {
      product_name: "Test Product",
      inventory_updated_at: "2024-01-15 10:30:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.inventory).toBeDefined();
    expect(result.inventory?.updatedAt).toBeInstanceOf(Date);
  });

  it("parses both product and inventory timestamps", () => {
    const row = {
      product_name: "Test Product",
      product_created_at: "2024-01-10 08:00:00",
      product_updated_at: "2024-01-15 10:30:00",
      inventory_created_at: "2024-01-12 09:00:00",
      inventory_updated_at: "2024-01-16 11:00:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    expect(result.product?.createdAt).toBeInstanceOf(Date);
    expect(result.product?.updatedAt).toBeInstanceOf(Date);
    expect(result.inventory?.createdAt).toBeInstanceOf(Date);
    expect(result.inventory?.updatedAt).toBeInstanceOf(Date);
  });

  it("handles null date parsing result", async () => {
    const { parseCSVDate } = vi.mocked(
      await import("~/server/repo/csv/date-utils"),
    );
    parseCSVDate.mockReturnValueOnce(null);

    const row = {
      product_name: "Test Product",
      product_created_at: "invalid-date",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestamps(row as PartialRow as InventoryCSVRow);

    // When parseCSVDate returns null, the field should be undefined
    expect(result.product?.createdAt).toBeUndefined();
  });
});

describe("parseRowTimestamps with SYNC_TIMESTAMPS disabled", () => {
  it("returns undefined timestamps when SYNC_TIMESTAMPS is false", async () => {
    // Reset modules to apply new mock
    vi.resetModules();

    // Re-mock with SYNC_TIMESTAMPS = false
    vi.doMock("~/server/repo/sync/config", () => ({
      SYNC_TIMESTAMPS: false,
    }));

    // Re-import the function with new mock
    const { parseRowTimestamps: parseRowTimestampsDisabled } = await import(
      "./row-processor"
    );

    const row = {
      product_name: "Test Product",
      product_created_at: "2024-01-15 10:30:00",
      inventory_created_at: "2024-01-15 10:30:00",
      quantity: 5,
      unit: "each",
    };

    const result = parseRowTimestampsDisabled(
      row as PartialRow as InventoryCSVRow,
    );

    expect(result.product).toBeUndefined();
    expect(result.inventory).toBeUndefined();
  });
});
