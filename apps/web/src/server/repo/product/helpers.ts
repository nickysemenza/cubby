/**
 * Product repository helper functions.
 * Includes lookup utilities.
 */

import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";

/**
 * Convert a product to a USDA food lookup parameter.
 *
 * An explicit `fdc_id` (the deliberate link a user picks) wins over UPC
 * auto-matching, so a product can override its sparse branded record with a
 * richer reference food. `ndb_number` is no longer consulted — the migration
 * folded every NDB link into `fdc_id`. Only returns a param if values validate.
 */
export const foodLookupParamFromProduct = (product: {
  upc: string | null;
  fdc_id: number | null;
}): FoodLookupParam | null => {
  // Explicit FDC link wins.
  if (product.fdc_id !== null) {
    const result = foodLookupParam.safeParse({
      kind: "fdc",
      fdc_id: product.fdc_id,
    });
    if (result.success) return result.data;
  }
  // Otherwise auto-resolve a branded food from the barcode.
  if (product.upc !== null) {
    const result = foodLookupParam.safeParse({
      kind: "upc",
      gtin_upc: product.upc,
    });
    if (result.success) return result.data;
  }
  return null;
};
