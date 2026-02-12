/**
 * Manufacturer matching utilities
 *
 * Provides consistent handling of manufacturer values across the codebase,
 * including the "(unspecified)" wildcard matching logic used in CSV import/export.
 */

import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";

/**
 * Check if a manufacturer value represents "unspecified"
 * (empty, null, whitespace-only, or the literal "(unspecified)" value)
 */
export function isUnspecifiedManufacturer(
  manufacturer: string | null | undefined,
): boolean {
  if (!manufacturer) return true;
  const trimmed = manufacturer.trim().toLowerCase();
  return trimmed === "" || trimmed === UNSPECIFIED_MANUFACTURER.toLowerCase();
}
