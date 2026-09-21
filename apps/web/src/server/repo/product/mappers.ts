import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import {
  canonicalExternalIdUrl,
  GTIN_SOURCE,
  persistedExternalIdKind,
} from "@cubby/schemas/external-id";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  InventoryListProductOut,
  ProductInventoryEmbedOut,
} from "@cubby/schemas/inventory";
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
import type { RowWithOptionalAliasesAndTags } from "~/server/repo/database-helpers";
import {
  isNotDeleted,
  type MappableImageRecord,
  mapImages,
  mapRelation,
  parseInventoryAmount,
  type RowWithOptionalAliases,
} from "~/server/repo/database-helpers";
import { mapLocationIdentityProduct } from "~/server/repo/location/identity-product";
import { parseLocationType } from "~/server/repo/location/parse-type";

import type { MappableProductExternalId } from "./external-id-types";
import { type ProductPricing, resolveProductPricing } from "./pricing";
import type { QuantityLedger } from "./quantity-ledger";
import type { ProductDeepDB, ProductListDB } from "./types";

type ProductImageRow =
  | MappableImageRecord
  | {
      image: MappableImageRecord;
      deletedAt?: Date | null;
    };

type ProductTopLevelDB = Omit<
  RowWithOptionalAliases<typeof product.$inferSelect>,
  "growsIngredientId"
> & {
  growsIngredientId?: (typeof product.$inferSelect)["growsIngredientId"];
  images?: ProductImageRow[] | null;
  externalIds?: MappableProductExternalId[] | null;
  dataQuality: ProductTopLevelOut["dataQuality"];
  pricing?: ProductPricing;
  // Batch-resolved by the caller via `getProductCoverImageUrlsByProductIds`
  // (same rule the picker uses). Optional: callers that never asked for it
  // (e.g. ingredient-relation reads) fall back to `null` below.
  coverImageUrl?: string | null;
  /** Loaded where a public product response needs the garden source relation. */
  growsIngredient?: { shortcode: string } | null;
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
      const kind = persistedExternalIdKind(externalId.kind);
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

export const mapDbProductToTopLevel = (
  productData: ProductTopLevelDB,
): ProductTopLevelOut => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  aliases: productData.aliases ?? [],
  tags: productData.tags ?? [],
  primaryGtin: primaryGtinOf(productData.externalIds),
  fdc_id: productData.fdc_id,
  manufacturer: productData.manufacturer,
  model: productData.model,
  notes: productData.notes,
  expectedQuantity: productData.expectedQuantity,
  category: productData.category,
  growsIngredientId: productData.growsIngredient
    ? parseShortcodeFor("ingredient", productData.growsIngredient.shortcode)
    : null,
  price: productData.price,
  pricing: productData.pricing ?? resolveProductPricing(productData.price),
  usdaUnavailable: productData.usdaUnavailable,
  stockTracked: productData.stockTracked,
  labelNutrition: productData.labelNutrition,
  dataQuality: productData.dataQuality,
  images: mapImages(productData.images),
  // Same derived cover rule as the picker (see
  // `getProductCoverImageUrlsByProductIds`); `null` when the caller didn't
  // batch-resolve it for this read.
  coverImageUrl: productData.coverImageUrl ?? null,
  externalIds: mapProductExternalIds(productData.externalIds),
  createdAt: productData.createdAt,
  updatedAt: productData.updatedAt,
});

export const dbProductToTopLevelAPI = (
  productData: ProductTopLevelDB,
): ProductTopLevelOut => {
  const result = mapDbProductToTopLevel(productData);

  return parseWithContext(productTopLevelOut, result, {
    entityType: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

const mapDbProductToPickerItem = (
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "manufacturer" | "category"
  > & {
    coverImageUrl: ProductPickerItemOut["coverImageUrl"];
    price: ProductPickerItemOut["price"];
    quantityLedger: ProductPickerItemOut["quantityLedger"];
    onHand: ProductPickerItemOut["onHand"];
  },
): ProductPickerItemOut => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
  category: productData.category,
  price: productData.price,
  coverImageUrl: productData.coverImageUrl,
  quantityLedger: productData.quantityLedger,
  onHand: productData.onHand,
});

export const dbProductToPickerItemAPI = (
  productData: Pick<
    typeof product.$inferSelect,
    "id" | "shortcode" | "name" | "manufacturer" | "category"
  > & {
    coverImageUrl: ProductPickerItemOut["coverImageUrl"];
    price: ProductPickerItemOut["price"];
    quantityLedger: ProductPickerItemOut["quantityLedger"];
    onHand: ProductPickerItemOut["onHand"];
  },
): ProductPickerItemOut => {
  const result = mapDbProductToPickerItem(productData);

  return parseWithContext(productPickerItemOut, result, {
    entityType: "Product",
    identifier: { id: productData.id, name: productData.name },
  });
};

export const mapDbProductToInventoryEmbed = (
  productData: RowWithOptionalAliases<typeof product.$inferSelect> & {
    pricing: ProductPricing;
    primaryGtin: string | null;
  },
): ProductInventoryEmbedOut => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  primaryGtin: productData.primaryGtin,
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

export const mapDbProductToInventoryList = (
  productData: RowWithOptionalAliases<typeof product.$inferSelect> & {
    pricing?: ProductPricing;
    primaryGtin: string | null;
  },
): InventoryListProductOut => ({
  id: parseShortcodeFor("product", productData.shortcode),
  name: productData.name,
  manufacturer: productData.manufacturer,
  primaryGtin: productData.primaryGtin,
  fdc_id: productData.fdc_id,
  category: productData.category,
  expectedQuantity: productData.expectedQuantity,
  model: productData.model,
  price:
    productData.pricing?.effectivePrice ??
    resolveProductPricing(productData.price).effectivePrice,
  usdaUnavailable: productData.usdaUnavailable,
});

const mapDbProductIngredient = (
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
  locationData: RowWithOptionalAliasesAndTags<typeof location.$inferSelect>,
) => ({
  id: parseShortcodeFor("location", locationData.shortcode),
  name: locationData.name,
  type: parseLocationType(locationData.type, {
    id: locationData.id,
    name: locationData.name,
  }),
});

/**
 * List-shaped stock rows for one product: live entries in live locations,
 * paired with a compact location ref.
 *
 * Exported because the product list is no longer the only reader — any table
 * showing "where does this thing live" for a product it merely references goes
 * through here, so the surfaces cannot disagree about which entries count. The
 * `isNotDeleted(entry.location)` filter is the load-bearing half: it matches
 * `dbProductToAPI` and `onHandUnitsSql`, and dropping it is how a detail read
 * once counted an entry whose LOCATION was soft-deleted while the list did not.
 */
export const mapProductListInventoryEntries = (
  entries: ProductListDB["inventoryEntry"],
) =>
  mapRelation(
    entries.filter((entry) => isNotDeleted(entry.location)),
    (entry) => ({
      id: parseShortcodeFor("inventory", entry.shortcode),
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      verifiedAt: entry.verifiedAt,
      placement: entry.placement,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      location: mapDbLocationToProductListInventory(entry.location),
    }),
  );

/**
 * The ledger, live units on the shelf, and the gap between them — the block
 * shared by the list row and the detail response.
 *
 * One function on purpose. The list used to own this and the detail page
 * computed its own on-hand inline, which is exactly how the SQL and the render
 * drifted twice: a filter can decide "mismatched" on a number the cell never
 * shows. Both surfaces now read the same three fields.
 *
 * Computed from the already-loaded `inventoryEntry` relation rather than a
 * correlated subquery — both shapes join those rows anyway.
 *
 * `onHandUnits`/`quantityVariance` go null when the entries carry more than one
 * unit. Summing `each` against `can` produces a number that means nothing, and
 * quietly adding them would manufacture a discrepancy out of a unit mismatch.
 * (In practice this is rare — live inventory is essentially all `each` — which
 * is exactly why an unguarded sum would have looked correct right up until it
 * wasn't.) `quantityLedger` is always present: it is ledger-only, so no unit
 * ambiguity can reach it.
 *
 * On-hand is the UNION of stock and identity: inventory units PLUS
 * `quantityLedger.locationCount`, the Locations that ARE this product. This is
 * the TS half of the rule `onHandUnitsSql` implements in SQL for sorting and
 * filtering — keep the two in step, they are one rule with two call sites.
 */
type ProductQuantitySummary = Pick<
  ProductListItem,
  "quantityLedger" | "onHandUnits" | "quantityVariance"
>;

const deriveProductQuantitySummary = (
  entries: ReadonlyArray<{ amount: { value: number; unit: string } }>,
  quantityLedger: QuantityLedger,
): ProductQuantitySummary => {
  const empty = {
    quantityLedger,
    onHandUnits: null,
    quantityVariance: null,
  };
  const { locationCount } = quantityLedger;
  if (entries.length === 0 && locationCount === 0) return empty;

  // Locations are one unit apiece, so they never widen the unit set — but a
  // mixed-unit shelf is still unanswerable regardless of them.
  const units = uniq(entries.map((entry) => entry.amount.unit));
  if (units.length > 1) return empty;

  const onHandUnits =
    sumBy(entries, (entry) => entry.amount.value) + locationCount;
  return {
    quantityLedger,
    onHandUnits,
    quantityVariance: onHandUnits - quantityLedger.expectedQuantity,
  };
};

export const dbProductToListAPI = (
  productData: ProductListDB,
  displayImages: DisplayImageSummary[],
): ProductListItem => {
  const inventoryEntry = mapProductListInventoryEntries(
    productData.inventoryEntry,
  );
  const result = {
    ...mapDbProductToTopLevel(productData),
    displayImages,
    ingredient:
      productData.ingredient && isNotDeleted(productData.ingredient)
        ? mapDbProductIngredient(productData.ingredient)
        : null,
    unitMappings: mapProductUnitMappings(
      parseShortcodeFor("product", productData.shortcode),
      productData.unitMappings,
    ),
    modelPresence: Boolean(productData.model),
    upcPresence: Boolean(primaryGtinOf(productData.externalIds)),
    notesPresence: Boolean(productData.notes),
    dataGaps: productData.dataQuality.gaps.map((gap) => gap.check),
    inventoryEntry,
    expenseCount: Number(productData.expenseCount),
    componentCount: Number(productData.componentCount),
    // Net basis: SUM(expense.cost), 0 for a product with no expenses (never
    // null) — mirrors `purchaseExpenseTotal`'s dbPurchaseToAPI coercion.
    expenseTotal: Number(productData.expenseTotal),
    purchaseDate: productData.purchaseDate,
    ...deriveProductQuantitySummary(inventoryEntry, productData.quantityLedger),
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

  // `isNotDeleted(entry.location)` matches `dbProductToListAPI` and
  // `onHandUnitsSql`, which inner-joins live locations. Without it a detail
  // read counted an entry whose LOCATION was soft-deleted while the list
  // dropped it — one product, two surfaces, different stock. Same drift the
  // `deriveProductQuantitySummary` docblock exists to prevent.
  const mappedInventoryEntry = mapRelation(
    inventoryEntry.filter((entry) => isNotDeleted(entry.location)),
    (entry) => ({
      id: parseShortcodeFor("inventory", entry.shortcode),
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      verifiedAt: entry.verifiedAt,
      placement: entry.placement,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      location: {
        id: parseShortcodeFor("location", entry.location.shortcode),
        name: entry.location.name,
        aliases: entry.location.aliases,
        notes: entry.location.notes ?? null,
        // Null whenever the location IS a product; only a present value is
        // validated against the enum.
        type: parseLocationType(entry.location.type, {
          id: entry.location.id,
          name: entry.location.name,
        }),
        product: mapLocationIdentityProduct(entry.location),
        lastBulkInventory: entry.location.lastBulkInventory,
        aiDescription: entry.location.aiDescription,
        images: mapImages(entry.location.images),
        displayImage: entry.location.displayImage ?? null,
        // Valuation is a whole-tree rollup; this movement-timeline embed is a
        // lightweight identity reference, not a place callers read this
        // location's own aggregate value from.
        valuation: null,
        ancestors: entry.location.ancestors ?? [],
        createdAt: entry.location.createdAt,
        updatedAt: entry.location.updatedAt,
      },
    }),
  );

  const result = {
    id: parseShortcodeFor("product", productData.shortcode),
    name: productData.name,
    aliases: productData.aliases ?? [],
    tags: productData.tags ?? [],
    primaryGtin: primaryGtinOf(productData.externalIds),
    fdc_id: productData.fdc_id,
    manufacturer: productData.manufacturer,
    model: productData.model,
    notes: productData.notes,
    expectedQuantity: productData.expectedQuantity,
    category: productData.category,
    growsIngredientId: productData.growsIngredient
      ? parseShortcodeFor("ingredient", productData.growsIngredient.shortcode)
      : null,
    price: productData.price,
    pricing: productData.pricing ?? resolveProductPricing(productData.price),
    usdaUnavailable: productData.usdaUnavailable,
    stockTracked: productData.stockTracked,
    labelNutrition: productData.labelNutrition,
    dataQuality,
    createdAt: productData.createdAt,
    updatedAt: productData.updatedAt,
    ingredient: ingredient ? mapDbProductIngredient(ingredient) : null,
    unitMappings: mapProductUnitMappings(
      parseShortcodeFor("product", productData.shortcode),
      unitMappings,
    ),
    externalIds: mapProductExternalIds(productData.externalIds),
    images: mapImages(images),
    // Same derived cover rule as the picker (see
    // `getProductCoverImageUrlsByProductIds`); `null` when the caller didn't
    // batch-resolve it for this read.
    coverImageUrl: productData.coverImageUrl ?? null,
    inventoryEntry: mappedInventoryEntry,
    // The bins in service, beside the stock held somewhere. `mapRelation`
    // drops soft-deleted rows, matching `quantityLedger.locationCount`, which
    // counts only live locations — the two must agree or the hero contradicts
    // the table beneath it.
    servingAsLocations: mapRelation(productData.locations ?? [], (loc) => ({
      id: parseShortcodeFor("location", loc.shortcode),
      name: loc.name,
      type: parseLocationType(loc.type, { id: loc.id, name: loc.name }),
      // This row carries no image columns — the select is scalar-only on
      // purpose — so the hydrated thumbnail is the only visual it has.
      displayImage: loc.displayImage ?? null,
      ancestors: loc.ancestors ?? [],
    })),
    // Counts edges, not units: a 4-pack held as one edge with `quantity: 4`
    // reads as 1. Non-zero is what makes this product a kit.
    componentCount: Number(productData.componentCount ?? 0),
    // A product may be the physical copy for many cookbooks. The query filters
    // both cookbook and recipe rows, while mapRelation remains a defensive
    // backstop for callers that construct ProductDeepDB directly.
    cookbooks: mapRelation(productData.cookbooks ?? [], (cb) => ({
      id: parseShortcodeFor("cookbook", cb.shortcode),
      name: cb.name,
      recipeCount:
        cb.recipes?.filter((recipe) => isNotDeleted(recipe)).length ?? 0,
    })),
    ...deriveProductQuantitySummary(
      mappedInventoryEntry,
      productData.quantityLedger,
    ),
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
