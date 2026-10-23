/** External Brand-name evidence can still contain a legacy unspecified token.
 * Stored Product identity uses a nullable Brand reference instead. */

import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";

/**
 * Check if a brandName value represents "unspecified"
 * (empty, null, whitespace-only, or the literal "(unspecified)" value)
 */
export function isUnknownBrandName(
  brandName: string | null | undefined,
): boolean {
  if (!brandName) return true;
  const trimmed = brandName.trim().toLowerCase();
  return trimmed === "" || trimmed === UNSPECIFIED_MANUFACTURER.toLowerCase();
}
