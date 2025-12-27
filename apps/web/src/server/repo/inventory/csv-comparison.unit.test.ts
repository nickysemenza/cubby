import { describe, it, expect } from "vitest";
import { getRowDifferences } from "./csv-comparison";
import type { InventoryCSVExportRow } from "./types";
import type { InventoryCSVRow } from "~/schemas/inventory";
import { unsafeProductId } from "~/schemas/identifiers";

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
    category: null,
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
