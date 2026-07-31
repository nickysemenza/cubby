import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type {
  inventoryListItemOut,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import { locationType } from "@cubby/schemas/location";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import {
  mapImages,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import {
  dbProductToInventoryEmbedShape,
  dbProductToInventoryListShape,
  mapProductExternalIds,
  mapProductUnitMappings,
} from "~/server/repo/product/mappers";
import type { InventoryEntryDeepDB, InventoryEntryListDB } from "./types";

type InventoryEntryBaseDB = Pick<
  InventoryEntryListDB,
  | "id"
  | "shortcode"
  | "amount"
  | "valuation"
  | "verifiedAt"
  | "createdAt"
  | "updatedAt"
>;

const inventoryEntryBaseShape = (entry: InventoryEntryBaseDB) => ({
  id: entry.id,
  shortcode: unsafeInventoryShortcode(entry.shortcode),
  amount: parseInventoryAmount(entry.amount, entry.id),
  valuation: entry.valuation,
  verifiedAt: entry.verifiedAt,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseShape(inventoryentry),
    location: {
      id: location.id,
      shortcode: unsafeLocationShortcode(location.shortcode),
      lastBulkInventory: location.lastBulkInventory,
      aiDescription: location.aiDescription,
      images: mapImages(location.images),
      valuation: location.valuation,
      name: location.name,
      aliases: location.aliases ?? [],
      type: parseWithContext(locationType, location.type, {
        entityType: "Location",
        identifier: { id: location.id, name: location.name },
      }),
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
    },
    product: {
      ...dbProductToInventoryEmbedShape(product),
      images: mapImages(product.images),
      externalIds: mapProductExternalIds(product.externalIds),
      unitMappings: mapProductUnitMappings(product.id, product.unitMappings),
    },
  };
};

export const dbInventoryEntryToListAPI: (
  inventoryentry: InventoryEntryListDB,
) => z.infer<typeof inventoryListItemOut> = (inventoryentry) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseShape(inventoryentry),
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
