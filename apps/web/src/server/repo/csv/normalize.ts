/**
 * Shared normalization utilities for CSV comparison
 */

/**
 * Normalize a string for case-insensitive comparison
 * Used for location names, product names, etc.
 */
export function normalizeForComparison(value: string): string {
  return value.toLowerCase().trim();
}
