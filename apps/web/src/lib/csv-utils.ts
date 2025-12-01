/**
 * CSV utility functions for parsing, building, and downloading CSV files.
 */

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
