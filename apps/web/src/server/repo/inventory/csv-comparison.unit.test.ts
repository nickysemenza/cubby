import { describe, it, expect } from "vitest";
import {
  makeInventoryKey,
  getRowDifferences,
  compareInventoryForPush,
  findRemovedInventoryForPull,
} from "./csv-comparison";
import type { InventoryCSVExportRow } from "./types";
import type { InventoryCSVRow } from "~/schemas/inventory";
import {
  unsafeLocationId,
  unsafeProductId,
  unsafeInventoryId,
} from "~/schemas/identifiers";

// Helper to create a minimal export row
function makeAppRow(
  overrides: Partial<InventoryCSVExportRow> & {
    product_name: string;
    manufacturer: string;
  },
): InventoryCSVExportRow {
  const { product_name, manufacturer, ...rest } = overrides;
  return {
    product_name,
    manufacturer,
    upc: "",
    model: null,
    ndb_number: null,
    location_name: "",
    location_id: null,
    inventory_entry_id: null,
    product_id: unsafeProductId("prod-1"),
    quantity: null,
    unit: null,
    expected_qty: null,
    price: null,
    unit_mappings: null,
    ingredient_name: null,
    aliases: null,
    product_image: null,
    ...rest,
  };
}

// Helper to create a minimal sheet/import row
function makeSheetRow(
  overrides: Partial<InventoryCSVRow> & { product_name: string },
): InventoryCSVRow {
  const { product_name, ...rest } = overrides;
  return {
    product_name,
    quantity: 1,
    unit: "each",
    ...rest,
  };
}

describe("makeInventoryKey", () => {
  it("should create consistent key from product, manufacturer, location", () => {
    const key = makeInventoryKey("Widget", "Acme Corp", "Kitchen > Shelf");
    expect(key).toBe("widget|acme corp|kitchen > shelf");
  });

  it("should be case insensitive", () => {
    const key1 = makeInventoryKey("Widget", "Acme Corp", "Kitchen");
    const key2 = makeInventoryKey("WIDGET", "ACME CORP", "KITCHEN");
    expect(key1).toBe(key2);
  });

  it("should normalize empty manufacturer to (unspecified)", () => {
    const key1 = makeInventoryKey("Widget", "", "Kitchen");
    const key2 = makeInventoryKey("Widget", "(unspecified)", "Kitchen");
    expect(key1).toBe(key2);
  });

  it("should normalize null/undefined manufacturer to (unspecified)", () => {
    const key1 = makeInventoryKey("Widget", null, "Kitchen");
    const key2 = makeInventoryKey("Widget", undefined, "Kitchen");
    const key3 = makeInventoryKey("Widget", "(unspecified)", "Kitchen");
    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });
});

describe("getRowDifferences", () => {
  it("should return empty array when rows match", () => {
    const appRow = makeAppRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_name: "Kitchen",
      quantity: 5,
      unit: "each",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_name: "Kitchen",
      quantity: 5,
      unit: "each",
    });

    const diffs = getRowDifferences(appRow, sheetRow);
    expect(diffs).toEqual([]);
  });

  it("should detect quantity changes", () => {
    const appRow = makeAppRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_name: "Kitchen",
      quantity: 10,
      unit: "each",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_name: "Kitchen",
      quantity: 5,
      unit: "each",
    });

    const diffs = getRowDifferences(appRow, sheetRow);
    expect(diffs).toContainEqual({ field: "qty", from: 5, to: 10 });
  });

  it("should detect unit changes", () => {
    const appRow = makeAppRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_name: "Kitchen",
      quantity: 5,
      unit: "box",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_name: "Kitchen",
      quantity: 5,
      unit: "each",
    });

    const diffs = getRowDifferences(appRow, sheetRow);
    expect(diffs).toContainEqual({ field: "unit", from: "each", to: "box" });
  });

  it("should detect UPC changes", () => {
    const appRow = makeAppRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_name: "Kitchen",
      upc: "123456789012",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_name: "Kitchen",
      upc: undefined,
    });

    const diffs = getRowDifferences(appRow, sheetRow);
    expect(diffs).toContainEqual({
      field: "upc",
      from: null,
      to: "123456789012",
    });
  });
});

describe("compareInventoryForPush", () => {
  it("should mark new items as created", () => {
    const appRows = [
      makeAppRow({
        product_name: "New Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
        quantity: 1,
        unit: "each",
      }),
    ];
    const sheetRows: InventoryCSVRow[] = [];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.created).toBe(1);
    expect(result.items[0].action).toBe("created");
    expect(result.items[0].productName).toBe("New Widget");
  });

  it("should mark unchanged items as skipped", () => {
    const appRows = [
      makeAppRow({
        product_name: "Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
        quantity: 5,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
        quantity: 5,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.skipped).toBe(1);
    expect(result.items[0].action).toBe("skipped");
  });

  it("should mark items in sheet but not in app as removed", () => {
    const appRows: InventoryCSVExportRow[] = [];
    const sheetRows = [
      makeSheetRow({
        product_name: "Old Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.removed).toBe(1);
    expect(result.items[0].action).toBe("removed");
    expect(result.items[0].productName).toBe("Old Widget");
  });

  it("should match items when app has real manufacturer but sheet has (unspecified)", () => {
    const appRows = [
      makeAppRow({
        product_name: "Dewalt Planer",
        manufacturer: "DeWalt",
        location_name: "Garage > Shelf",
        quantity: 1,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Dewalt Planer",
        manufacturer: "(unspecified)",
        location_name: "Garage > Shelf",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    // Should match as the same item, not show Add+Remove
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.removed ?? 0).toBe(0);
  });

  it("should match items when sheet has empty manufacturer", () => {
    const appRows = [
      makeAppRow({
        product_name: "Router Table",
        manufacturer: "Bosch",
        location_name: "Workshop",
        quantity: 1,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Router Table",
        manufacturer: undefined, // empty
        location_name: "Workshop",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.removed ?? 0).toBe(0);
  });

  it("should match items when app has (unspecified) and sheet has specific manufacturer", () => {
    const appRows = [
      makeAppRow({
        product_name: "Power Drill",
        manufacturer: "(unspecified)",
        location_name: "Garage",
        quantity: 1,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Power Drill",
        manufacturer: "Makita",
        location_name: "Garage",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    // Should match - (unspecified) is a wildcard
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.removed ?? 0).toBe(0);
  });

  it("should NOT match items with different specific manufacturers", () => {
    const appRows = [
      makeAppRow({
        product_name: "Table Saw",
        manufacturer: "DeWalt",
        location_name: "Workshop",
        quantity: 1,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Table Saw",
        manufacturer: "Bosch",
        location_name: "Workshop",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    // Different specific manufacturers = different products
    expect(result.created).toBe(1); // App item is new to sheet
    expect(result.removed).toBe(1); // Sheet item doesn't exist in app
  });

  it("should match multiple items with fuzzy manufacturers correctly", () => {
    const appRows = [
      makeAppRow({
        product_name: "Screwdriver",
        manufacturer: "DeWalt",
        location_name: "Toolbox",
        quantity: 1,
        unit: "each",
        product_id: unsafeProductId("prod-1"),
      }),
      makeAppRow({
        product_name: "Screwdriver",
        manufacturer: "Bosch",
        location_name: "Garage",
        quantity: 1,
        unit: "each",
        product_id: unsafeProductId("prod-2"),
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Screwdriver",
        manufacturer: "(unspecified)", // Should match one of them
        location_name: "Toolbox",
        quantity: 1,
        unit: "each",
      }),
      makeSheetRow({
        product_name: "Screwdriver",
        manufacturer: "(unspecified)", // Should match the other
        location_name: "Garage",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    // Both should match via fuzzy matching
    expect(result.skipped).toBe(2);
    expect(result.created).toBe(0);
    expect(result.removed ?? 0).toBe(0);
  });

  it("should show updated when quantities differ despite fuzzy manufacturer match", () => {
    const appRows = [
      makeAppRow({
        product_name: "Hammer",
        manufacturer: "Stanley",
        location_name: "Toolbox",
        quantity: 3,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Hammer",
        manufacturer: "(unspecified)",
        location_name: "Toolbox",
        quantity: 1,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.updated).toBe(1);
    expect(result.items[0].action).toBe("updated");
    expect(result.items[0].fieldChanges).toContainEqual({
      field: "qty",
      from: 1,
      to: 3,
    });
  });

  it("should include productId in result items for product links", () => {
    const appRows = [
      makeAppRow({
        product_name: "Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
        product_id: unsafeProductId("prod-123"),
        quantity: 5,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Widget",
        manufacturer: "Acme",
        location_name: "Kitchen",
        quantity: 5,
        unit: "each",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.items[0].productId).toBe("prod-123");
  });
});

describe("findRemovedInventoryForPull", () => {
  describe("product deletion", () => {
    it("should mark product for deletion when completely removed from sheet", () => {
      const appRows = [
        makeAppRow({
          product_name: "Deleted Product",
          manufacturer: "(unspecified)",
          location_name: "", // product-only
          product_id: unsafeProductId("prod-deleted"),
        }),
      ];
      const sheetRows: InventoryCSVRow[] = [];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("removed");
      expect(result[0].productName).toBe("Deleted Product");
      expect(result[0].productIdToDelete).toBe("prod-deleted");
      expect(result[0].inventoryEntryId).toBeUndefined();
    });

    it("should mark product for deletion when inventory row removed and no other rows exist", () => {
      const appRows = [
        makeAppRow({
          product_name: "Deleted Product",
          manufacturer: "(unspecified)",
          location_name: "Kitchen > Shelf",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-deleted"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows: InventoryCSVRow[] = [];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("removed");
      expect(result[0].productIdToDelete).toBe("prod-deleted");
    });

    it("should NOT mark product for deletion if it still exists in sheet (different location)", () => {
      const appRows = [
        makeAppRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Kitchen",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
        makeAppRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Garage",
          inventory_entry_id: unsafeInventoryId("inv-2"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      // Sheet only has Kitchen location, Garage was deleted
      const sheetRows = [
        makeSheetRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Kitchen",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      // Should only delete the inventory entry, not the product
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("removed");
      expect(result[0].productName).toBe("Widget");
      expect(result[0].locationName).toBe("Garage");
      expect(result[0].inventoryEntryId).toBe("inv-2");
      expect(result[0].productIdToDelete).toBeUndefined();
    });
  });

  describe("inventory entry deletion", () => {
    it("should mark inventory entry for deletion when location removed from sheet", () => {
      const appRows = [
        makeAppRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Kitchen",
          location_id: unsafeLocationId("loc-1"),
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      // Product exists as product-only in sheet (no location)
      const sheetRows = [
        makeSheetRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "", // product-only
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("removed");
      expect(result[0].inventoryEntryId).toBe("inv-1");
      expect(result[0].productIdToDelete).toBeUndefined();
      expect(result[0].message).toContain("Inventory entry");
    });

    it("should return empty when nothing changed", () => {
      const appRows = [
        makeAppRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Kitchen",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_name: "Kitchen",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(0);
    });
  });

  describe("case insensitivity", () => {
    it("should match products case-insensitively", () => {
      const appRows = [
        makeAppRow({
          product_name: "Widget",
          manufacturer: "Acme Corp",
          location_name: "Kitchen",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "WIDGET",
          manufacturer: "ACME CORP",
          location_name: "KITCHEN",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(0);
    });
  });

  describe("fuzzy manufacturer matching", () => {
    it("should NOT mark as removed when app has specific manufacturer but sheet has (unspecified)", () => {
      const appRows = [
        makeAppRow({
          product_name: "Dewalt Planer",
          manufacturer: "DeWalt",
          location_name: "Garage > Shelf",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Dewalt Planer",
          manufacturer: "(unspecified)", // Should match via fuzzy matching
          location_name: "Garage > Shelf",
          quantity: 1,
          unit: "each",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(0);
    });

    it("should NOT mark as removed when app has (unspecified) but sheet has specific manufacturer", () => {
      const appRows = [
        makeAppRow({
          product_name: "Router Table",
          manufacturer: "(unspecified)",
          location_name: "Workshop",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Router Table",
          manufacturer: "Bosch",
          location_name: "Workshop",
          quantity: 1,
          unit: "each",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(0);
    });

    it("should mark as removed when manufacturers are both specific and different", () => {
      const appRows = [
        makeAppRow({
          product_name: "Table Saw",
          manufacturer: "DeWalt",
          location_name: "Workshop",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "Table Saw",
          manufacturer: "Bosch", // Different specific manufacturer
          location_name: "Workshop",
          quantity: 1,
          unit: "each",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      // Different specific manufacturers = product doesn't exist in sheet
      expect(result).toHaveLength(1);
      expect(result[0].productIdToDelete).toBe("prod-1");
    });

    it("should handle multiple products with same name but different manufacturers", () => {
      const appRows = [
        makeAppRow({
          product_name: "All purpose flour",
          manufacturer: "King Arthur",
          location_name: "Pantry",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
        makeAppRow({
          product_name: "All purpose flour",
          manufacturer: "(unspecified)",
          location_name: "Pantry",
          inventory_entry_id: unsafeInventoryId("inv-2"),
          product_id: unsafeProductId("prod-2"),
          quantity: 1,
          unit: "each",
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "All purpose flour",
          manufacturer: "King Arthur",
          location_name: "Pantry",
          quantity: 1,
          unit: "each",
        }),
        makeSheetRow({
          product_name: "All purpose flour",
          manufacturer: "(unspecified)",
          location_name: "Pantry",
          quantity: 1,
          unit: "each",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      // Both products should be matched
      expect(result).toHaveLength(0);
    });
  });
});
