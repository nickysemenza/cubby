import { displayGtin, normalizeGtin } from "@cubby/schemas/external-id";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";

/**
 * Convert a product to a USDA food lookup parameter.
 *
 * An explicit `fdc_id` (the deliberate link a user picks) wins over barcode
 * auto-matching, so a product can override its sparse branded record with a
 * richer reference food. `ndb_number` is no longer consulted — the migration
 * folded every NDB link into `fdc_id`. Only returns a param if values validate.
 *
 * The barcode is sent as `displayGtin`, NOT the stored GTIN-14: `usda-api`
 * left-pads its `branded_food.gtin_upc` values to twelve and looks them up by
 * exact string match, so a 14-digit key misses nearly every branded food.
 */
export const foodLookupParamFromProduct = (product: {
  primaryGtin: string | null;
  fdc_id: number | null;
}): FoodLookupParam | null => {
  if (product.fdc_id !== null) {
    const result = foodLookupParam.safeParse({
      kind: "fdc",
      fdc_id: product.fdc_id,
    });
    if (result.success) return result.data;
  }
  const normalized =
    product.primaryGtin === null ? null : normalizeGtin(product.primaryGtin);
  if (normalized !== null) {
    const result = foodLookupParam.safeParse({
      kind: "upc",
      gtin_upc: displayGtin(normalized),
    });
    if (result.success) return result.data;
  }
  return null;
};
