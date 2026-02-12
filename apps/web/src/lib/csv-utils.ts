/**
 * CSV utility functions for parsing CSV files.
 */

import {
  type InventoryCSVRow,
  inventoryCSVRow,
} from "@cubby/schemas/inventory";
import Papa from "papaparse";

/**
 * Parse inventory CSV content into validated rows.
 * Handles header normalization and field mapping.
 *
 */
export function parseInventoryCSV(csvContent: string): InventoryCSVRow[] {
  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) =>
      header.toLowerCase().trim().replace(/\s+/g, "_"),
  });

  if (result.errors.length > 0) {
    console.error("CSV parse errors:", result.errors);
    throw new Error("Failed to parse CSV file");
  }

  const rows: InventoryCSVRow[] = [];
  for (const row of result.data) {
    const parsed = inventoryCSVRow.safeParse({
      product_name: row.product_name || row.product || row.name,
      manufacturer: row.manufacturer || undefined,
      upc: row.upc || row.barcode || undefined,
      model: row.model || undefined,
      ndb_number: row.ndb_number || row.ndbnumber || undefined,
      location_name: row.location_name || row.location || undefined,
      quantity: row.quantity || row.qty || 1,
      unit: row.unit || "each",
      expected_qty: row.expected_qty || row.expectedqty || undefined,
      price: row.price || undefined,
      unit_mappings: row.unit_mappings || row.unitmappings || undefined,
      ingredient_name: row.ingredient_name || undefined,
      ingredient: row.ingredient,
      aliases: row.aliases || undefined,
    });

    if (!parsed.success) {
      console.error(`Row validation error:`, row, parsed.error);
      throw new Error(`Failed to validate CSV row`);
    }
    rows.push(parsed.data);
  }

  return rows;
}
