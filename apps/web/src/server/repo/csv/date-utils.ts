/**
 * CSV date parsing utilities
 *
 * Shared date parsing for CSV import and comparison.
 */

import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

// Supported date formats for CSV/Sheet data
const CSV_DATE_FORMATS = [
  "YYYY-MM-DD HH:mm:ss", // App format
  "M/D/YYYY H:mm:ss", // Sheets format (single digits)
  "MM/DD/YYYY HH:mm:ss", // Sheets format (padded)
];

/**
 * Parse date string from CSV/Sheet to Date object
 * Handles both app format (YYYY-MM-DD HH:mm:ss) and Sheets format (MM/DD/YYYY HH:mm:ss)
 */
export const parseCSVDate = (
  dateStr: string | null | undefined,
): Date | null => {
  if (!dateStr) return null;

  for (const fmt of CSV_DATE_FORMATS) {
    const parsed = dayjs(dateStr, fmt, true);
    if (parsed.isValid()) {
      return parsed.toDate();
    }
  }

  // Fallback: try native parsing
  const fallback = dayjs(dateStr);
  return fallback.isValid() ? fallback.toDate() : null;
};

/**
 * Parse date string and return unix timestamp for comparison
 */
export const parseCSVDateToUnix = (
  dateStr: string | null | undefined,
): number | null => {
  const date = parseCSVDate(dateStr);
  return date ? Math.floor(date.getTime() / 1000) : null;
};
