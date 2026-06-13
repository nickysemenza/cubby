import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { locationType } from "@cubby/schemas/location";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
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
    id: restOfInventoryEntry.id,
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: restOfLocation.id,
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
      id: Product.id,
      shortcode: unsafeProductShortcode(Product.shortcode),
      unitMappings: addProductSourceMetadata(Product.id, Product.unitMappings),
      externalIds: Product.externalIds.filter((eid) => eid.deletedAt === null),
      images: extractImagesFromJoinTable(Product.images),
    },
  };
};
