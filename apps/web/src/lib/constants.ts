/**
 * Default manufacturer name for products without a known manufacturer
 */
export const UNSPECIFIED_MANUFACTURER = "(unspecified)";

/**
 * Prefix for misc/bulk products that skip validation (pricing, UPC, etc.)
 */
const MISC_PREFIX = "misc:";

/**
 * Check if a product name indicates it's a misc/bulk item
 */
export function isMiscProduct(name: string): boolean {
  return name.toLowerCase().startsWith(MISC_PREFIX);
}

/**
 * Get display name for a misc product (without the prefix)
 */
export function getMiscDisplayName(name: string): string {
  if (isMiscProduct(name)) {
    return name.slice(MISC_PREFIX.length).trim();
  }
  return name;
}
