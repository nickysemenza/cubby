/**
 * Product repository helper functions.
 * Includes DB-to-API transformations and lookup utilities.
 */

import { productWithIngredientAndInventoryAndMappingsOut } from "@cubby/schemas/combo";
import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { locationType } from "@cubby/schemas/location";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import {
  addProductSourceMetadata,
  extractImagesFromJoinTable,
  mapRelation,
} from "~/server/repo/database-helpers";

import type { ProductDeepDB } from "./types";

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

/**
 * Transform a deeply nested product DB record to API format.
 * Handles shortcode branding, image extraction, and nested transforms.
 */
export const dbProductToAPI = (
  productData: ProductDeepDB,
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const {
    Ingredient,
    unitMappings,
    externalIds,
    InventoryEntry,
    images,
    shortcode,
    ...restOfProduct
  } = productData;

  const result = {
    ...restOfProduct,
    shortcode: shortcode ? unsafeProductShortcode(shortcode) : null,
    ingredient: Ingredient,
    unitMappings: addProductSourceMetadata(productData.id, unitMappings),
    externalIds: externalIds.filter((eid) => eid.deletedAt === null),
    images: extractImagesFromJoinTable(images),
    inventoryEntry: mapRelation(InventoryEntry, (entry) => {
      const {
        type,
        images: locationImages,
        ...restOfLocation
      } = entry.location;

      return {
        ...entry,
        amount: entry.amount as { value: number; unit: string },
        location: {
          ...restOfLocation,
          id: restOfLocation.id,
          shortcode: restOfLocation.shortcode
            ? unsafeLocationShortcode(restOfLocation.shortcode)
            : null,
          type: locationType.parse(type),
          images: extractImagesFromJoinTable(locationImages),
        },
      };
    }),
  };

  return parseWithContext(
    productWithIngredientAndInventoryAndMappingsOut,
    result,
    {
      entityType: "Product",
      identifier: { id: productData.id, name: productData.name },
    },
  );
};
