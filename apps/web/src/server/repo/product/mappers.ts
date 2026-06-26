import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import { locationType } from "@cubby/schemas/location";
import {
  type ProductPickerItemOut,
  type ProductTopLevelOut,
  productPickerItemOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { productWithIngredientAndInventoryAndMappingsOut } from "@cubby/schemas/product-responses";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import type {
  image,
  product,
  productExternalId,
  productUnitMappings,
} from "~/server/db/schema";
import {
  mapRelation,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import type { ProductDeepDB } from "./types";

type ProductImageRow =
  | typeof image.$inferSelect
  | {
      image: typeof image.$inferSelect;
      deletedAt?: Date | null;
    };

type ProductTopLevelDB = typeof product.$inferSelect & {
  images?: ProductImageRow[] | null;
  externalIds?: Array<typeof productExternalId.$inferSelect> | null;
};

export const mapProductImages = (
  images: ProductImageRow[] | undefined | null,
): ImageOut[] => {
  if (!images) return [];

  return images
    .filter((row) => !("deletedAt" in row) || row.deletedAt === null)
    .map((row) => {
      const dbImage = "image" in row ? row.image : row;
      return {
        id: dbImage.id,
        url: dbImage.url,
        key: dbImage.key,
        filename: dbImage.filename,
        size: dbImage.size,
        contentType: dbImage.contentType,
        status: dbImage.status,
        createdAt: dbImage.createdAt,
        updatedAt: dbImage.updatedAt,
      };
    });
};

export const mapProductExternalIds = (
  externalIds: Array<typeof productExternalId.$inferSelect> | undefined | null,
) =>
  (externalIds ?? [])
    .filter((externalId) => externalId.deletedAt === null)
    .map((externalId) => ({
      id: externalId.id,
      source: externalId.source,
      externalId: externalId.externalId,
      url: externalId.url,
      createdAt: externalId.createdAt,
      updatedAt: externalId.updatedAt,
    }));

export const mapProductUnitMappings = (
  productId: ProductTopLevelOut["id"],
  unitMappings: Array<typeof productUnitMappings.$inferSelect>,
) =>
  unitMappings
    .filter((unitMapping) => unitMapping.deletedAt === null)
    .map((unitMapping) => ({
      id: unitMapping.id,
      a: unitMapping.a,
      b: unitMapping.b,
      source: unitMapping.source,
      sourceMetadata: {
        type: "product" as const,
        productId,
      },
      createdAt: unitMapping.createdAt,
      updatedAt: unitMapping.updatedAt,
    }));

export const dbProductToTopLevelShape = (
  productData: ProductTopLevelDB,
): ProductTopLevelOut => ({
  id: productData.id,
  shortcode: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  manufacturer: productData.manufacturer,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  price: productData.price,
  usdaUnavailable: productData.usdaUnavailable,
  images: mapProductImages(productData.images),
  externalIds: mapProductExternalIds(productData.externalIds),
  createdAt: productData.createdAt,
  updatedAt: productData.updatedAt,
});

export const dbProductToTopLevelAPI = (
  productData: ProductTopLevelDB,
): ProductTopLevelOut => {
  const result = dbProductToTopLevelShape(productData);

  return parseWithContext(productTopLevelOut, result, {
    entityType: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

const dbProductToPickerItemShape = (
  productData: typeof product.$inferSelect,
): ProductPickerItemOut => ({
  id: productData.id,
  shortcode: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
});

export const dbProductToPickerItemAPI = (
  productData: typeof product.$inferSelect,
): ProductPickerItemOut => {
  const result = dbProductToPickerItemShape(productData);

  return parseWithContext(productPickerItemOut, result, {
    entityType: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

/**
 * Transform a deeply nested product DB record to API format.
 * Handles shortcode branding, image extraction, and nested transforms.
 */
export const dbProductToAPI = (
  productData: ProductDeepDB,
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const { ingredient, unitMappings, inventoryEntry, images } = productData;

  const result = {
    id: productData.id,
    shortcode: unsafeProductShortcode(productData.shortcode),
    name: productData.name,
    upc: productData.upc,
    fdc_id: productData.fdc_id,
    manufacturer: productData.manufacturer,
    model: productData.model,
    notes: productData.notes,
    expectedQuantity: productData.expectedQuantity,
    category: productData.category,
    price: productData.price,
    usdaUnavailable: productData.usdaUnavailable,
    createdAt: productData.createdAt,
    updatedAt: productData.updatedAt,
    ingredient: ingredient
      ? {
          id: ingredient.id,
          name: ingredient.name,
          aliases: ingredient.aliases,
          naKinds: ingredient.naKinds,
          createdAt: ingredient.createdAt,
          updatedAt: ingredient.updatedAt,
        }
      : null,
    unitMappings: mapProductUnitMappings(productData.id, unitMappings),
    externalIds: mapProductExternalIds(productData.externalIds),
    images: mapProductImages(images),
    inventoryEntry: mapRelation(inventoryEntry, (entry) => {
      return {
        id: entry.id,
        amount: parseInventoryAmount(entry.amount, entry.id),
        valuation: entry.valuation,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        location: {
          id: entry.location.id,
          shortcode: unsafeLocationShortcode(entry.location.shortcode),
          name: entry.location.name,
          type: parseWithContext(locationType, entry.location.type, {
            entityType: "Location",
            identifier: {
              id: entry.location.id,
              name: entry.location.name,
            },
          }),
          lastBulkInventory: entry.location.lastBulkInventory,
          aiDescription: entry.location.aiDescription,
          images: mapProductImages(entry.location.images),
          valuation: entry.location.valuation,
          createdAt: entry.location.createdAt,
          updatedAt: entry.location.updatedAt,
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
