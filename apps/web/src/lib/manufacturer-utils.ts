/**
 * Manufacturer matching utilities
 *
 * Provides consistent handling of manufacturer values across the codebase,
 * including the "(unspecified)" wildcard matching logic used in CSV import/export.
 */

import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";

/**
 * Normalize a manufacturer value:
 * - Empty/null/undefined becomes UNSPECIFIED_MANUFACTURER
 * - Whitespace is trimmed
 */
export function normalizeManufacturer(
  manufacturer: string | null | undefined,
): string {
  const trimmed = manufacturer?.trim();
  return trimmed || UNSPECIFIED_MANUFACTURER;
}

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

/**
 * Check if updating manufacturer from current to new value is a meaningful change.
 * Returns the new manufacturer value if it should be updated, undefined otherwise.
 *
 * Logic: Only update if going from "(unspecified)" to a specific value.
 * Don't update if both are specific (even if different) or if new is unspecified.
 */
export function getManufacturerUpdate(
  currentManufacturer: string,
  newManufacturer: string | null | undefined,
): string | undefined {
  const isCurrentUnspecified = isUnspecifiedManufacturer(currentManufacturer);
  const isNewSpecific = !isUnspecifiedManufacturer(newManufacturer);

  if (isCurrentUnspecified && isNewSpecific) {
    return normalizeManufacturer(newManufacturer);
  }
  return undefined;
}
