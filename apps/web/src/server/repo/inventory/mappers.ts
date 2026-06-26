import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  inventoryListItemOut,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory-responses";
import { locationType } from "@cubby/schemas/location";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import {
  addProductSourceMetadata,
  extractImagesFromJoinTable,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import type { InventoryEntryDeepDB, InventoryEntryListDB } from "./types";

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

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
        const { ingredientId: _ingredientId, ...rest } = product;
        return rest;
      })(),
      id: product.id,
      shortcode: unsafeProductShortcode(product.shortcode),
      unitMappings: addProductSourceMetadata(product.id, product.unitMappings),
      externalIds: product.externalIds.filter((eid) => eid.deletedAt === null),
      images: extractImagesFromJoinTable(product.images),
    },
  };
};

export const dbInventoryEntryToListAPI: (
  inventoryentry: InventoryEntryListDB,
) => z.infer<typeof inventoryListItemOut> = (inventoryentry) => {
  const { product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, ...restOfLocation } = location;

  const parsedAmount = parseInventoryAmount(
    restOfInventoryEntry.amount,
    restOfInventoryEntry.id,
  );

  return {
    ...restOfInventoryEntry,
    id: restOfInventoryEntry.id,
    amount: parsedAmount,
    location: {
      id: restOfLocation.id,
      shortcode: unsafeLocationShortcode(restOfLocation.shortcode),
      name: restOfLocation.name,
      type: parseWithContext(locationType, type, {
        entityType: "Location",
        identifier: { id: restOfLocation.id, name: restOfLocation.name },
      }),
    },
    product: {
      id: product.id,
      shortcode: unsafeProductShortcode(product.shortcode),
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
      fdc_id: product.fdc_id,
      category: product.category,
      expectedQuantity: product.expectedQuantity,
      model: product.model,
      price: product.price,
      usdaUnavailable: product.usdaUnavailable,
    },
  };
};
