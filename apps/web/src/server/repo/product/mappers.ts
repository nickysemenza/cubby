import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { locationType } from "@cubby/schemas/location";
import { productWithIngredientAndInventoryAndMappingsOut } from "@cubby/schemas/product-responses";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import {
  addProductSourceMetadata,
  extractImagesFromJoinTable,
  mapRelation,
} from "~/server/repo/database-helpers";
import type { ProductDeepDB } from "./types";

/**
 * Transform a deeply nested product DB record to API format.
 * Handles shortcode branding, image extraction, and nested transforms.
 */
export const dbProductToAPI = (
  productData: ProductDeepDB,
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const {
    ingredient,
    unitMappings,
    externalIds,
    inventoryEntry,
    images,
    shortcode,
    ...restOfProduct
  } = productData;

  const result = {
    ...restOfProduct,
    shortcode: shortcode ? unsafeProductShortcode(shortcode) : null,
    ingredient,
    unitMappings: addProductSourceMetadata(productData.id, unitMappings),
    externalIds: externalIds.filter((eid) => eid.deletedAt === null),
    images: extractImagesFromJoinTable(images),
    inventoryEntry: mapRelation(inventoryEntry, (entry) => {
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
