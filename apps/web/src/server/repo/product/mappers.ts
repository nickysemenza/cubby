import { canonicalExternalIdUrl } from "@cubby/schemas/external-id";
import {
  unsafeIngredientShortcode,
  unsafeInventoryShortcode,
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
  productListItemOut,
  productPickerItemOut,
  productTopLevelOut,
  productWithIngredientAndInventoryAndMappingsOut,
} from "@cubby/schemas/product";
import { sumBy, uniq } from "es-toolkit";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import type {
  ingredient,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import {
  isNotDeleted,
  type MappableImageRecord,
  mapImages,
  mapRelation,
  parseInventoryAmount,
  type RowWithOptionalAliases,
} from "~/server/repo/database-helpers";
import type { MappableProductExternalId } from "./external-id-types";
import { type ProductPricing, resolveProductPricing } from "./pricing";
import type { ProductDeepDB, ProductListDB } from "./types";

type ProductImageRow =
  | MappableImageRecord
  | {
      image: MappableImageRecord;
      deletedAt?: Date | null;
    };

type ProductTopLevelDB = RowWithOptionalAliases<typeof product.$inferSelect> & {
  images?: ProductImageRow[] | null;
  externalIds?: MappableProductExternalId[] | null;
  dataQuality: ProductTopLevelOut["dataQuality"];
  pricing?: ProductPricing;
};

export const mapProductExternalIds = (
  externalIds: MappableProductExternalId[] | undefined | null,
) =>
  (externalIds ?? [])
    .filter((externalId) => externalId.deletedAt === null)
    .map((externalId) => {
      const kind = (externalId.kind ??
        "legacy_unspecified") as import("@cubby/schemas/external-id").ExternalIdKind;
      return {
        id: externalId.id,
        source: externalId.source,
        kind,
        externalId: externalId.externalId,
        url: canonicalExternalIdUrl({ ...externalId, kind }),
        createdAt: externalId.createdAt,
        updatedAt: externalId.updatedAt,
      };
    });

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
  id: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  aliases: productData.aliases ?? [],
  tags: productData.tags ?? [],
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  manufacturer: productData.manufacturer,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  price: productData.price,
  pricing: productData.pricing ?? resolveProductPricing(productData.price),
  usdaUnavailable: productData.usdaUnavailable,
  dataQuality: productData.dataQuality,
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
  id: unsafeProductShortcode(productData.shortcode),
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
  productData: RowWithOptionalAliases<typeof product.$inferSelect> & {
    pricing: ProductPricing;
  },
): ProductInventoryEmbedOut => ({
  id: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  manufacturer: productData.manufacturer,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  price: productData.pricing.effectivePrice,
  usdaUnavailable: productData.usdaUnavailable,
  createdAt: productData.createdAt,
  updatedAt: productData.updatedAt,
});

export const dbProductToInventoryListShape = (
  productData: RowWithOptionalAliases<typeof product.$inferSelect> & {
    pricing?: ProductPricing;
  },
): InventoryListProductOut => ({
  id: unsafeProductShortcode(productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
  upc: productData.upc,
  fdc_id: productData.fdc_id,
  category: productData.category,
  expectedQuantity: productData.expectedQuantity,
  model: productData.model,
  price:
    productData.pricing?.effectivePrice ??
    resolveProductPricing(productData.price).effectivePrice,
  usdaUnavailable: productData.usdaUnavailable,
});

const dbProductIngredientToShape = (
  ingredientData: typeof ingredient.$inferSelect,
) => ({
  id: unsafeIngredientShortcode(ingredientData.shortcode),
  name: ingredientData.name,
  aliases: ingredientData.aliases,
  naKinds: ingredientData.naKinds,
  createdAt: ingredientData.createdAt,
  updatedAt: ingredientData.updatedAt,
});

const dbLocationToProductListInventoryShape = (
  locationData: RowWithOptionalAliases<typeof location.$inferSelect>,
) => ({
  id: unsafeLocationShortcode(locationData.shortcode),
  name: locationData.name,
  type: parseWithContext(locationType, locationData.type, {
    entityType: "Location",
    identifier: { id: locationData.id, name: locationData.name },
  }),
});

/**
 * Live units on the shelf, and how far they sit from the ledger.
 *
 * Computed from the already-loaded `inventoryEntry` relation rather than a
 * fifth correlated subquery — the list joins those rows for the Locations
 * column regardless.
 *
 * Both go null when the entries carry more than one unit. Summing `each`
 * against `can` produces a number that means nothing, and a Variance column
 * that quietly adds them would manufacture a discrepancy out of a unit
 * mismatch. (In practice this is rare — live inventory is essentially all
 * `each` — which is exactly why an unguarded sum would have looked correct
 * right up until it wasn't.)
 */
const deriveOnHandUnits = (
  entries: ReadonlyArray<{ amount: { value: number; unit: string } }>,
  expectedQuantity: number,
): { onHandUnits: number | null; quantityVariance: number | null } => {
  if (entries.length === 0)
    return { onHandUnits: null, quantityVariance: null };

  const units = uniq(entries.map((entry) => entry.amount.unit));
  if (units.length > 1) return { onHandUnits: null, quantityVariance: null };

  const onHandUnits = sumBy(entries, (entry) => entry.amount.value);
  return { onHandUnits, quantityVariance: onHandUnits - expectedQuantity };
};

export const dbProductToListAPI = (
  productData: ProductListDB,
): ProductListItem => {
  const inventoryEntry = mapRelation(
    productData.inventoryEntry.filter((entry) => isNotDeleted(entry.location)),
    (entry) => ({
      id: unsafeInventoryShortcode(entry.shortcode),
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      verifiedAt: entry.verifiedAt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      location: dbLocationToProductListInventoryShape(entry.location),
    }),
  );
  const result = {
    ...dbProductToTopLevelShape(productData),
    ingredient:
      productData.ingredient && isNotDeleted(productData.ingredient)
        ? dbProductIngredientToShape(productData.ingredient)
        : null,
    unitMappings: mapProductUnitMappings(
      unsafeProductShortcode(productData.shortcode),
      productData.unitMappings,
    ),
    inventoryEntry,
    // count() returns bigint (string over the wire), so coerce — mirrors the
    // ingredient list's appearsInRecipes/recipeCount handling.
    expenseCount: Number(productData.expenseCount),
    // Net basis: SUM(expense.cost), 0 for a product with no expenses (never
    // null) — mirrors `purchaseExpenseTotal`'s dbPurchaseToAPI coercion.
    expenseTotal: Number(productData.expenseTotal),
    purchaseDate: productData.purchaseDate,
    quantityLedger: productData.quantityLedger,
    ...deriveOnHandUnits(
      inventoryEntry,
      productData.quantityLedger.expectedQuantity,
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
  dataQuality: ProductTopLevelOut["dataQuality"],
): z.infer<typeof productWithIngredientAndInventoryAndMappingsOut> => {
  const { ingredient, unitMappings, inventoryEntry, images } = productData;

  const result = {
    id: unsafeProductShortcode(productData.shortcode),
    name: productData.name,
    aliases: productData.aliases ?? [],
    tags: productData.tags ?? [],
    upc: productData.upc,
    fdc_id: productData.fdc_id,
    manufacturer: productData.manufacturer,
    model: productData.model,
    notes: productData.notes,
    expectedQuantity: productData.expectedQuantity,
    category: productData.category,
    price: productData.price,
    pricing: productData.pricing ?? resolveProductPricing(productData.price),
    usdaUnavailable: productData.usdaUnavailable,
    dataQuality,
    createdAt: productData.createdAt,
    updatedAt: productData.updatedAt,
    ingredient: ingredient ? dbProductIngredientToShape(ingredient) : null,
    unitMappings: mapProductUnitMappings(
      unsafeProductShortcode(productData.shortcode),
      unitMappings,
    ),
    externalIds: mapProductExternalIds(productData.externalIds),
    images: mapImages(images),
    inventoryEntry: mapRelation(inventoryEntry, (entry) => {
      return {
        id: unsafeInventoryShortcode(entry.shortcode),
        amount: parseInventoryAmount(entry.amount, entry.id),
        valuation: entry.valuation,
        verifiedAt: entry.verifiedAt,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        location: {
          id: unsafeLocationShortcode(entry.location.shortcode),
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
