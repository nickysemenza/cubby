import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
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
  id: unsafeInventoryShortcode(entry.shortcode),
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
  const amount = parseInventoryAmount(inventoryentry.amount, inventoryentry.id);
  const effectivePrice =
    inventoryentry.valuation !== null && amount.value !== 0
      ? inventoryentry.valuation / amount.value
      : product.price;

  return {
    ...inventoryEntryBaseShape(inventoryentry),
    location: {
      id: unsafeLocationShortcode(location.shortcode),
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
      ...dbProductToInventoryEmbedShape({
        ...product,
        pricing: {
          derivedPrice: null,
          effectivePrice,
          source: product.price !== null ? "explicit" : "derived",
          knownExpenseCount: 0,
          unknownExpenseCount: 0,
          knownUnitCount: 0,
          partial: false,
        },
      }),
      images: mapImages(product.images),
      externalIds: mapProductExternalIds(product.externalIds),
      unitMappings: mapProductUnitMappings(
        unsafeProductShortcode(product.shortcode),
        product.unitMappings,
      ),
    },
  };
};

export const dbInventoryEntryToListAPI: (
  inventoryentry: InventoryEntryListDB,
) => z.infer<typeof inventoryListItemOut> = (inventoryentry) => {
  const { product, location } = inventoryentry;
  const amount = parseInventoryAmount(inventoryentry.amount, inventoryentry.id);
  const effectivePrice =
    inventoryentry.valuation !== null && amount.value !== 0
      ? inventoryentry.valuation / amount.value
      : product.price;

  return {
    ...inventoryEntryBaseShape(inventoryentry),
    location: {
      id: unsafeLocationShortcode(location.shortcode),
      name: location.name,
      type: parseWithContext(locationType, location.type, {
        entityType: "Location",
        identifier: { id: location.id, name: location.name },
      }),
    },
    product: dbProductToInventoryListShape({
      ...product,
      pricing: {
        derivedPrice: null,
        effectivePrice,
        source: product.price !== null ? "explicit" : "derived",
        knownExpenseCount: 0,
        unknownExpenseCount: 0,
        knownUnitCount: 0,
        partial: false,
      },
    }),
  };
};
