/**
 * CSV utility functions for parsing, building, and downloading CSV files.
 */

import Papa from "papaparse";
import { inventoryCSVRow, type InventoryCSVRow } from "~/schemas/inventory";
import { locationType, type LocationType } from "~/schemas/location";

/** Row from locations.csv */
export interface LocationCSVRow {
  location_name: string;
  parent_name: string | null;
  location_type: LocationType | null;
  description: string | null;
}

/**
 * Convert any value to a CSV-safe string.
 * - null/undefined → ""
 * - numbers → string representation
 * - everything else → String(value)
 */
export const toCSVString = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  return String(value);
};

/**
 * Parse inventory CSV content into validated rows.
 * Handles header normalization and field mapping.
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

/**
 * Parse locations CSV content into rows.
 * Handles header normalization and field mapping.
 */
export function parseLocationsCSV(csvContent: string): LocationCSVRow[] {
  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) =>
      header.toLowerCase().trim().replace(/\s+/g, "_"),
  });

  if (result.errors.length > 0) {
    console.error("CSV parse errors:", result.errors);
    throw new Error("Failed to parse locations CSV file");
  }

  const rows: LocationCSVRow[] = [];
  for (const row of result.data) {
    const typeValue = row.location_type?.trim();
    const parsedType = typeValue ? locationType.safeParse(typeValue) : null;

    rows.push({
      location_name: row.location_name?.trim() || "",
      parent_name: row.parent_name?.trim() || null,
      location_type: parsedType?.success ? parsedType.data : null,
      description: row.description?.trim() || null,
    });
  }

  return rows;
}

/**
 * Escape a cell value for CSV format.
 * Wraps in quotes and escapes internal quotes by doubling them.
 */
function escapeCSVCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Build CSV content from headers and rows.
 * Handles proper escaping of values.
 *
 * @param headers - Array of header strings
 * @param rows - Array of row arrays (each row is an array of cell values)
 * @returns CSV formatted string
 */
export function buildCSVContent(headers: string[], rows: string[][]): string {
  return [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCSVCell).join(",")),
  ].join("\n");
}

/**
 * Trigger a browser download of CSV content.
 *
 * @param content - CSV content string
 * @param filename - Filename for the download (should end with .csv)
 */
export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generate a filename with a date suffix for exports.
 *
 * @param prefix - Filename prefix (e.g., "inventory-export")
 * @returns Filename with current date (e.g., "inventory-export-2024-01-15.csv")
 */
export function generateExportFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().split("T")[0]}.csv`;
}
