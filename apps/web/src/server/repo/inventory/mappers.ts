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
import { parseInventoryAmount } from "~/server/repo/database-helpers";
import {
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
      id: product.id,
      shortcode: unsafeProductShortcode(product.shortcode),
      images: mapProductImages(product.images),
      externalIds: mapProductExternalIds(product.externalIds),
      price: product.price,
      usdaUnavailable: product.usdaUnavailable,
      name: product.name,
      upc: product.upc,
      fdc_id: product.fdc_id,
      manufacturer: product.manufacturer,
      model: product.model,
      notes: product.notes,
      expectedQuantity: product.expectedQuantity,
      category: product.category,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
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
