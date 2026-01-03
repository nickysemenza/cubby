import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "~/schemas/identifiers";
import { locationType } from "~/schemas/location";
import {
  addProductSourceMetadata,
  extractImagesFromJoinTable,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import type { InventoryEntryDeepDB } from "./types";

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

  // Validate amount from JSON column
  const parsedAmount = parseInventoryAmount(
    restOfInventoryEntry.amount,
    restOfInventoryEntry.id,
  );

  return {
    ...restOfInventoryEntry,
    id: unsafeInventoryId(restOfInventoryEntry.id),
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: unsafeLocationId(restOfLocation.id),
      shortcode: unsafeLocationShortcode(restOfLocation.shortcode),
      type: parseWithContext(locationType, type, {
        entityType: "Location",
        identifier: { id: restOfLocation.id, name: restOfLocation.name },
      }),
      images: extractImagesFromJoinTable(locationImages),
    },
    product: {
      ...(() => {
        const { ingredientId: _ingredientId, ...rest } = Product;
        return rest;
      })(),
      id: unsafeProductId(Product.id),
      shortcode: unsafeProductShortcode(Product.shortcode),
      unitMappings: addProductSourceMetadata(Product.id, Product.unitMappings),
      images: extractImagesFromJoinTable(Product.images),
    },
  };
};
