import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import type {
  inventoryListItemOut,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { locationType } from "@cubby/schemas/location";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import { parseInventoryAmount } from "~/server/repo/database-helpers";
import {
  dbProductToInventoryEmbedShape,
  dbProductToInventoryListShape,
  mapProductExternalIds,
  mapProductImages,
  mapProductUnitMappings,
} from "~/server/repo/product/mappers";
import type { InventoryEntryDeepDB, InventoryEntryListDB } from "./types";

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { product, location } = inventoryentry;

  const parsedAmount = parseInventoryAmount(
    inventoryentry.amount,
    inventoryentry.id,
  );

  return {
    id: inventoryentry.id,
    amount: parsedAmount,
    valuation: inventoryentry.valuation,
    verifiedAt: inventoryentry.verifiedAt,
    createdAt: inventoryentry.createdAt,
    updatedAt: inventoryentry.updatedAt,
    location: {
      id: location.id,
      shortcode: unsafeLocationShortcode(location.shortcode),
      lastBulkInventory: location.lastBulkInventory,
      aiDescription: location.aiDescription,
      images: mapProductImages(location.images),
      valuation: location.valuation,
      name: location.name,
      type: parseWithContext(locationType, location.type, {
        entityType: "Location",
        identifier: { id: location.id, name: location.name },
      }),
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
    },
    product: {
      ...dbProductToInventoryEmbedShape(product),
      images: mapProductImages(product.images),
      externalIds: mapProductExternalIds(product.externalIds),
      unitMappings: mapProductUnitMappings(product.id, product.unitMappings),
    },
  };
};

export const dbInventoryEntryToListAPI: (
  inventoryentry: InventoryEntryListDB,
) => z.infer<typeof inventoryListItemOut> = (inventoryentry) => {
  const { product, location } = inventoryentry;

  const parsedAmount = parseInventoryAmount(
    inventoryentry.amount,
    inventoryentry.id,
  );

  return {
    id: inventoryentry.id,
    amount: parsedAmount,
    valuation: inventoryentry.valuation,
    verifiedAt: inventoryentry.verifiedAt,
    createdAt: inventoryentry.createdAt,
    updatedAt: inventoryentry.updatedAt,
    location: {
      id: location.id,
      shortcode: unsafeLocationShortcode(location.shortcode),
      name: location.name,
      type: parseWithContext(locationType, location.type, {
        entityType: "Location",
        identifier: { id: location.id, name: location.name },
      }),
    },
    product: dbProductToInventoryListShape(product),
  };
};
