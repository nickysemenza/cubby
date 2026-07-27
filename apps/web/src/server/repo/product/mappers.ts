import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  InventoryListProductOut,
  ProductInventoryEmbedOut,
} from "@cubby/schemas/inventory";
import { locationType } from "@cubby/schemas/location";
import {
  type ProductListItem,
  type ProductPickerItemOut,
  type ProductTopLevelOut,
  type ProductUnitMappingQuality,
  productListItemOut,
  productPickerItemOut,
  productTopLevelOut,
  productWithIngredientAndInventoryAndMappingsOut,
} from "@cubby/schemas/product";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import type {
  image,
  ingredient,
  location,
  product,
  productExternalId,
  productUnitMappings,
} from "~/server/db/schema";
import {
  isNotDeleted,
  mapImages,
  mapRelation,
  parseInventoryAmount,
  type RowWithOptionalAliases,
} from "~/server/repo/database-helpers";
import type { ProductDeepDB, ProductListDB } from "./types";

type ProductImageRow =
  | typeof image.$inferSelect
  | {
      image: typeof image.$inferSelect;
      deletedAt?: Date | null;
    };

type ProductTopLevelDB = RowWithOptionalAliases<typeof product.$inferSelect> & {
  images?: ProductImageRow[] | null;
  externalIds?: Array<typeof productExternalId.$inferSelect> | null;
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

const productUnitMappingQuality = (
  productData: ProductListDB,
): ProductUnitMappingQuality => {
  const activeMappingCount = productData.unitMappings.filter(
    (unitMapping) => unitMapping.deletedAt === null,
  ).length;
  if (activeMappingCount >= 3) return "complete";
  if (activeMappingCount >= 2) return "good";
  if (
    activeMappingCount >= 1 ||
    productData.price != null ||
    productData.fdc_id != null ||
    productData.upc != null
  ) {
    return "partial";
  }
  return "none";
};

export const dbProductToTopLevelShape = (
  productData: ProductTopLevelDB,
): ProductTopLevelOut => ({
  id: productData.id,
  shortcode: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  aliases: productData.aliases ?? [],
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  manufacturer: productData.manufacturer,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  price: productData.price,
  usdaUnavailable: productData.usdaUnavailable,
  images: mapImages(productData.images),
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
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "manufacturer"
  >,
): ProductPickerItemOut => ({
  id: productData.id,
  shortcode: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
});

export const dbProductToPickerItemAPI = (
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "manufacturer"
  >,
): ProductPickerItemOut => {
  const result = dbProductToPickerItemShape(productData);

  return parseWithContext(productPickerItemOut, result, {
    entityType: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

export const dbProductToInventoryEmbedShape = (
  productData: RowWithOptionalAliases<typeof product.$inferSelect>,
): ProductInventoryEmbedOut => ({
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
});

export const dbProductToInventoryListShape = (
  productData: RowWithOptionalAliases<typeof product.$inferSelect>,
): InventoryListProductOut => ({
  id: productData.id,
  shortcode: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  category: productData.category,
  expectedQuantity: productData.expectedQuantity,
  model: productData.model,
  price: productData.price,
  usdaUnavailable: productData.usdaUnavailable,
});

const dbProductIngredientToShape = (
  ingredientData: typeof ingredient.$inferSelect,
) => ({
  id: ingredientData.id,
  name: ingredientData.name,
  aliases: ingredientData.aliases,
  naKinds: ingredientData.naKinds,
  createdAt: ingredientData.createdAt,
  updatedAt: ingredientData.updatedAt,
});

const dbLocationToProductListInventoryShape = (
  locationData: RowWithOptionalAliases<typeof location.$inferSelect>,
) => ({
  id: locationData.id,
  shortcode: unsafeLocationShortcode(locationData.shortcode),
  name: locationData.name,
  type: parseWithContext(locationType, locationData.type, {
    entityType: "Location",
    identifier: { id: locationData.id, name: locationData.name },
  }),
});

export const dbProductToListAPI = (
  productData: ProductListDB,
): ProductListItem => {
  const result = {
    ...dbProductToTopLevelShape(productData),
    ingredient:
      productData.ingredient && isNotDeleted(productData.ingredient)
        ? dbProductIngredientToShape(productData.ingredient)
        : null,
    unitMappings: mapProductUnitMappings(
      productData.id,
      productData.unitMappings,
    ),
    unitMappingQuality: productUnitMappingQuality(productData),
    inventoryEntry: mapRelation(
      productData.inventoryEntry.filter((entry) =>
        isNotDeleted(entry.location),
      ),
      (entry) => ({
        id: entry.id,
        amount: parseInventoryAmount(entry.amount, entry.id),
        valuation: entry.valuation,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        location: dbLocationToProductListInventoryShape(entry.location),
      }),
    ),
  };

  return parseWithContext(productListItemOut, result, {
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
    aliases: productData.aliases ?? [],
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
    ingredient: ingredient ? dbProductIngredientToShape(ingredient) : null,
    unitMappings: mapProductUnitMappings(productData.id, unitMappings),
    externalIds: mapProductExternalIds(productData.externalIds),
    images: mapImages(images),
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
          aliases: entry.location.aliases,
          type: parseWithContext(locationType, entry.location.type, {
            entityType: "Location",
            identifier: {
              id: entry.location.id,
              name: entry.location.name,
            },
          }),
          lastBulkInventory: entry.location.lastBulkInventory,
          aiDescription: entry.location.aiDescription,
          images: mapImages(entry.location.images),
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
