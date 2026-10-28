import {
  canonicalExternalIdUrl,
  externalIdKind,
  GTIN_SOURCE,
} from "@cubby/schemas/external-id";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { ImageAnalysisSummary } from "@cubby/schemas/image";
import type {
  RawInventoryListProduct,
  RawProductInventoryEmbed,
} from "@cubby/schemas/inventory-fields";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import type { RawProductCategorySummary } from "@cubby/schemas/product-category-fields";
import {
  rawProductPickerItem,
  type RawProductPickerItem,
} from "@cubby/schemas/product-raw-read";
import type { RawProductOutput } from "@cubby/schemas/product-raw-read";

import type { CategoryStockTracking } from "~/server/db/computed/product-category-sql";
import {
  isNotDeleted,
  type MappableImageRecord,
  mapImages,
  mapRelation,
  parseInventoryAmount,
} from "~/server/db/helpers";
import type {
  ingredient,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import { resolveStockTrackingField } from "~/server/domains/inventory/repo/stock-tracking";
import type { MappableProductExternalId } from "~/server/domains/product/repo/external-id-types";
import { parseWithContext } from "~/server/lib/zod-utils";

import { type ProductPricing, resolveProductPriceField } from "./pricing";
import type { ProductDeepDB, ProductListDB } from "./types";
import { unitMappingSides } from "./unit-mappings";

type ProductImageRow =
  | MappableImageRecord
  | {
      image: MappableImageRecord;
      purpose?: "item" | "label" | null;
      deletedAt?: Date | null;
    };

const productImagePurposeOf = (row: ProductImageRow): "item" | "label" =>
  "image" in row && row.purpose === "label" ? "label" : "item";

const productImageShortcodeOf = (row: ProductImageRow): string =>
  ("image" in row ? row.image : row).shortcode;

/**
 * Every image shortcode attached to a Product's joined image rows (item and
 * label alike). A caller loading `analysisSummaries` for the detail images
 * batches `loadImageAnalysisSummaries` over exactly this set.
 */
export const productImageShortcodesOf = (
  rows: ProductDeepDB["images"] | null | undefined,
): string[] => (rows ?? []).map(productImageShortcodeOf);

const mapProductImages = (
  rows: ProductImageRow[],
  analysisSummaries?: Map<string, ImageAnalysisSummary>,
) =>
  rows.flatMap((row) =>
    mapImages([row]).map((image) => ({
      ...image,
      // The absence of a role on an older join is evidence in its own right;
      // do not rewrite it to the item default used only for grouping/covers.
      purpose: "image" in row ? (row.purpose ?? null) : null,
      // Populated only when the caller (a Product detail/get read) loaded
      // `analysisSummaries` — absent on a list read, which passes none, to
      // keep list cost flat.
      analysisSummary: analysisSummaries?.get(image.id) ?? null,
    })),
  );

/**
 * Split a Product's joined image rows into item/label galleries.
 *
 * `analysisSummaries`, when supplied, is a pre-loaded batch (the
 * detail images binding) keyed by image shortcode — never loaded here, so a list
 * read that never passes it stays a single query regardless of image count.
 */
export const splitProductImages = (
  rows: ProductImageRow[] | null | undefined,
  analysisSummaries?: Map<string, ImageAnalysisSummary>,
) => {
  const itemRows = (rows ?? []).filter(
    (row) => productImagePurposeOf(row) === "item",
  );
  const labelRows = (rows ?? []).filter(
    (row) => productImagePurposeOf(row) === "label",
  );
  const filesOf = (items: ProductImageRow[]) =>
    mapProductImages(items, analysisSummaries);
  const itemImages = filesOf(itemRows);
  const labelImages = filesOf(labelRows);
  return {
    itemImages,
    labelImages,
    itemImageCount: itemImages.filter(isDisplayableImageFile).length,
    labelImageCount: labelImages.filter(isDisplayableImageFile).length,
  };
};

/**
 * The barcode that stands for a product, from its already-loaded external ids.
 *
 * Derived rather than queried: every caller that emits `primaryGtin` on a
 * top-level product shape has `externalIds` in hand, so this costs nothing. A
 * slot can be left with no primary (removing one promotes the oldest survivor,
 * but a replace-payload can leave the slot empty), so fall back to the first
 * live barcode rather than reporting none.
 */
export const primaryGtinOf = (
  externalIds: MappableProductExternalId[] | undefined | null,
): string | null => {
  const live = (externalIds ?? []).filter(
    (row) => row.deletedAt === null && row.source === GTIN_SOURCE,
  );
  return (
    live.find((row) => row.isPrimary)?.externalId ?? live[0]?.externalId ?? null
  );
};

export const mapProductExternalIds = (
  externalIds: MappableProductExternalId[] | undefined | null,
) =>
  (externalIds ?? [])
    .filter((externalId) => externalId.deletedAt === null)
    .map((externalId) => {
      const kind = externalIdKind.parse(externalId.kind);
      return {
        id: externalId.id,
        source: externalId.source,
        kind,
        externalId: externalId.externalId,
        url: canonicalExternalIdUrl({ ...externalId, kind }),
        // Rows written before the column existed default to primary, which is
        // what they were: back then a slot held exactly one row.
        isPrimary: externalId.isPrimary ?? true,
        createdAt: externalId.createdAt,
        updatedAt: externalId.updatedAt,
      };
    });

export const mapProductUnitMappings = (
  productId: RawProductOutput["id"],
  unitMappings: Array<typeof productUnitMappings.$inferSelect>,
) =>
  unitMappings
    .filter((unitMapping) => unitMapping.deletedAt === null)
    .map((unitMapping) => ({
      id: unitMapping.id,
      ...unitMappingSides(unitMapping),
      source: unitMapping.source,
      sourceMetadata: {
        type: "product" as const,
        productId,
      },
      createdAt: unitMapping.createdAt,
      updatedAt: unitMapping.updatedAt,
    }));

/** Every Product read derives its resolutions here, list and detail alike. */
export const productFieldResolutions = (
  productData: Pick<typeof product.$inferSelect, "price" | "stockTracked"> & {
    category: RawProductCategorySummary | null;
    categoryStockTracking: CategoryStockTracking | null;
  },
  pricing: ProductPricing,
): FieldResolutions => ({
  price: resolveProductPriceField(
    productData.price,
    pricing,
    isServiceProductCategory(productData.category),
  ),
  stockTracked: resolveStockTrackingField(
    productData.stockTracked,
    productData.categoryStockTracking,
    "product decision",
  ),
});

const mapDbProductToPickerItem = (
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "categoryId"
  > & {
    brandCode: import("@cubby/schemas/identifiers").VendorShortcode | null;
    brandName: string | null;
    category: RawProductCategorySummary | null;
    coverImageUrl: RawProductPickerItem["coverImageUrl"];
    price: RawProductPickerItem["price"];
    quantityLedger: RawProductPickerItem["quantityLedger"];
    onHand: RawProductPickerItem["onHand"];
    displayFacts: RawProductPickerItem["displayFacts"];
  },
): RawProductPickerItem => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  brandId: productData.brandCode,
  brandName: productData.brandName,
  category: productData.category,
  categoryFeature: productData.category?.feature ?? null,
  price: productData.price,
  coverImageUrl: productData.coverImageUrl,
  quantityLedger: productData.quantityLedger,
  onHand: productData.onHand,
  displayFacts: productData.displayFacts,
});

export const dbProductToPickerItemAPI = (
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "categoryId"
  > & {
    brandCode: import("@cubby/schemas/identifiers").VendorShortcode | null;
    brandName: string | null;
    category: RawProductCategorySummary | null;
    coverImageUrl: RawProductPickerItem["coverImageUrl"];
    price: RawProductPickerItem["price"];
    quantityLedger: RawProductPickerItem["quantityLedger"];
    onHand: RawProductPickerItem["onHand"];
    displayFacts: RawProductPickerItem["displayFacts"];
  },
): RawProductPickerItem => {
  const result = mapDbProductToPickerItem(productData);

  return parseWithContext(rawProductPickerItem, result, {
    entityKind: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

export const mapDbProductToInventoryEmbed = (
  productData: typeof product.$inferSelect & {
    brandName: string | null;
    category: RawProductCategorySummary | null;
    effectivePrice: number | null;
    primaryGtin: string | null;
  },
): RawProductInventoryEmbed => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  primaryGtin: productData.primaryGtin,
  fdc_id: productData.fdc_id,
  brandName: productData.brandName,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  categoryFeature: productData.category?.feature ?? null,
  price: productData.effectivePrice,
  usdaUnavailable: productData.usdaUnavailable,
  createdAt: productData.createdAt,
  updatedAt: productData.updatedAt,
});

export const mapDbProductToInventoryList = (
  productData: typeof product.$inferSelect & {
    brandName: string | null;
    category: RawProductCategorySummary | null;
    effectivePrice: number | null;
    primaryGtin: string | null;
  },
): RawInventoryListProduct => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  brandName: productData.brandName,
  primaryGtin: productData.primaryGtin,
  fdc_id: productData.fdc_id,
  category: productData.category,
  categoryFeature: productData.category?.feature ?? null,
  expectedQuantity: productData.expectedQuantity,
  model: productData.model,
  price: productData.effectivePrice,
  usdaUnavailable: productData.usdaUnavailable,
});

export const mapDbProductIngredient = (
  ingredientData: typeof ingredient.$inferSelect,
) => ({
  id: parseShortcodeFor("ingredient", ingredientData.shortcode),
  name: ingredientData.name,
  aliases: ingredientData.aliases,
  naKinds: ingredientData.naKinds,
  createdAt: ingredientData.createdAt,
  updatedAt: ingredientData.updatedAt,
});

const mapDbLocationToProductListInventory = (
  locationData: typeof location.$inferSelect,
) => ({
  id: parseShortcodeFor("location", locationData.shortcode),
  name: locationData.name,
});

/**
 * List-shaped stock rows for one product: live entries in live locations,
 * paired with a compact location ref.
 *
 * Exported because the product list is no longer the only reader — any table
 * showing "where does this thing live" for a product it merely references goes
 * through here, so the surfaces cannot disagree about which entries count. The
 * `isNotDeleted(entry.location)` filter is the load-bearing half: it matches
 * `onHandUnitsSql`, and dropping it is how a detail read
 * once counted an entry whose LOCATION was soft-deleted while the list did not.
 */
export const mapProductListInventoryEntries = (
  entries: ProductListDB["inventoryEntry"],
) =>
  mapRelation(
    entries.filter((entry) => isNotDeleted(entry.location)),
    (entry) => ({
      id: parseShortcodeFor("inventory", entry.shortcode),
      amount: parseInventoryAmount(entry),
      valuation: entry.valuation,
      verifiedAt: entry.verifiedAt,
      placement: entry.placement,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      location: mapDbLocationToProductListInventory(entry.location),
    }),
  );
