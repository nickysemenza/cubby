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
    location_path: "",
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

  it("should normalize location paths with brackets", () => {
    const key1 = makeInventoryKey("Widget", "Acme", "Kitchen[room]");
    const key2 = makeInventoryKey("Widget", "Acme", "Kitchen");
    expect(key1).toBe(key2);
  });
});

describe("getRowDifferences", () => {
  it("should return empty array when rows match", () => {
    const appRow = makeAppRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_path: "Kitchen",
      quantity: 5,
      unit: "each",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      manufacturer: "Acme",
      location_path: "Kitchen",
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
      location_path: "Kitchen",
      quantity: 10,
      unit: "each",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_path: "Kitchen",
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
      location_path: "Kitchen",
      quantity: 5,
      unit: "box",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_path: "Kitchen",
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
      location_path: "Kitchen",
      upc: "123456789012",
    });
    const sheetRow = makeSheetRow({
      product_name: "Widget",
      location_path: "Kitchen",
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
        location_path: "Kitchen",
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
        location_path: "Kitchen",
        quantity: 5,
        unit: "each",
      }),
    ];
    const sheetRows = [
      makeSheetRow({
        product_name: "Widget",
        manufacturer: "Acme",
        location_path: "Kitchen",
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
        location_path: "Kitchen",
      }),
    ];

    const result = compareInventoryForPush(appRows, sheetRows);

    expect(result.removed).toBe(1);
    expect(result.items[0].action).toBe("removed");
    expect(result.items[0].productName).toBe("Old Widget");
  });
});

describe("findRemovedInventoryForPull", () => {
  describe("product deletion", () => {
    it("should mark product for deletion when completely removed from sheet", () => {
      const appRows = [
        makeAppRow({
          product_name: "Deleted Product",
          manufacturer: "(unspecified)",
          location_path: "", // product-only
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
          location_path: "Kitchen > Shelf",
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
          location_path: "Kitchen",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
          quantity: 1,
          unit: "each",
        }),
        makeAppRow({
          product_name: "Widget",
          manufacturer: "(unspecified)",
          location_path: "Garage",
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
          location_path: "Kitchen",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      // Should only delete the inventory entry, not the product
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe("removed");
      expect(result[0].productName).toBe("Widget");
      expect(result[0].locationPath).toBe("Garage");
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
          location_path: "Kitchen",
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
          location_path: "", // product-only
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
          location_path: "Kitchen",
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
          location_path: "Kitchen",
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
          location_path: "Kitchen",
          inventory_entry_id: unsafeInventoryId("inv-1"),
          product_id: unsafeProductId("prod-1"),
        }),
      ];
      const sheetRows = [
        makeSheetRow({
          product_name: "WIDGET",
          manufacturer: "ACME CORP",
          location_path: "KITCHEN",
        }),
      ];

      const result = findRemovedInventoryForPull(appRows, sheetRows);

      expect(result).toHaveLength(0);
    });
  });
});
