/**
 * Shared normalization utilities for CSV comparison
 */

// Re-export manufacturer utils for convenience
export {
  normalizeManufacturer,
  manufacturersMatch,
} from "~/lib/manufacturer-utils";

/**
 * Normalize a string for case-insensitive comparison
 * Used for location names, product names, etc.
 */
export function normalizeForComparison(value: string): string {
  return value.toLowerCase().trim();
}
