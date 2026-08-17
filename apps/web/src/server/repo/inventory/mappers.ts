import {
  type ProductId,
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  inventoryListItemOut,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import type { z } from "zod";
import {
  mapImages,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { mapLocationIdentityProduct } from "~/server/repo/location/identity-product";
import { parseLocationType } from "~/server/repo/location/parse-type";
import {
  dbProductToInventoryEmbedShape,
  dbProductToInventoryListShape,
  mapProductExternalIds,
  mapProductUnitMappings,
} from "~/server/repo/product/mappers";
import type { ProductPricing } from "~/server/repo/product/pricing";
import type { InventoryEntryDeepDB, InventoryEntryListDB } from "./types";

type InventoryEntryBaseDB = Pick<
  InventoryEntryListDB,
  | "id"
  | "shortcode"
  | "amount"
  | "valuation"
  | "verifiedAt"
  | "placement"
  | "createdAt"
  | "updatedAt"
>;

const inventoryEntryBaseShape = (entry: InventoryEntryBaseDB) => ({
  id: unsafeInventoryShortcode(entry.shortcode),
  amount: parseInventoryAmount(entry.amount, entry.id),
  valuation: entry.valuation,
  verifiedAt: entry.verifiedAt,
  placement: entry.placement,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
});

/** `loadProductPricing` returns one row per requested Product; fail loudly if
 * an inventory relation and that batch ever fall out of sync. */
export const requireLoadedProductPricing = (
  pricing: ReadonlyMap<ProductId, ProductPricing>,
  productId: ProductId,
): ProductPricing => {
  const value = pricing.get(productId);
  if (!value) {
    throw new Error(`Missing pricing for inventory product ${productId}`);
  }
  return value;
};

export const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
  pricing: ProductPricing,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (
  inventoryentry,
  pricing,
) => {
  const { product, location } = inventoryentry;

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
      type: parseLocationType(location.type, {
        id: location.id,
        name: location.name,
      }),
      // The inventory embed carries the holding location's own identity so a
      // stock row can render the bin it sits in without a second fetch.
      product: mapLocationIdentityProduct(location),
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
    },
    product: {
      ...dbProductToInventoryEmbedShape({
        ...product,
        pricing,
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
  pricing: ProductPricing,
) => z.infer<typeof inventoryListItemOut> = (inventoryentry, pricing) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseShape(inventoryentry),
    location: {
      id: unsafeLocationShortcode(location.shortcode),
      name: location.name,
      type: parseLocationType(location.type, {
        id: location.id,
        name: location.name,
      }),
    },
    product: dbProductToInventoryListShape({
      ...product,
      pricing,
    }),
  };
};
