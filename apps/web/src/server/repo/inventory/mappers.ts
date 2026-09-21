import type { DataQuality } from "@cubby/schemas/data-quality";
import { type ProductId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  inventoryDisplayName,
  type inventoryListItemOut,
  type inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import type { EffectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import type { z } from "zod";

import {
  mapImages,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { mapLocationIdentityProduct } from "~/server/repo/location/identity-product";
import { parseLocationType } from "~/server/repo/location/parse-type";
import {
  mapDbProductToInventoryEmbed,
  mapDbProductToInventoryList,
  mapProductExternalIds,
  mapProductUnitMappings,
  primaryGtinOf,
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
  | "ownershipMode"
  | "createdAt"
  | "updatedAt"
>;

const unresolvedOwnership = (
  entry: InventoryEntryBaseDB,
): EffectiveInventoryOwnership => ({
  mode: entry.ownershipMode,
  explicitOwner: null,
  effectiveOwner: null,
  source: entry.ownershipMode === "unassigned" ? "unassigned" : "unresolved",
  basis: null,
  evidence: null,
  evidenceFingerprint: "unresolved",
  matchesInheritedOwner: false,
});

const inventoryEntryBaseFields = (
  entry: InventoryEntryBaseDB,
  dataQuality: DataQuality,
  ownership: EffectiveInventoryOwnership = unresolvedOwnership(entry),
) => ({
  id: parseShortcodeFor("inventory", entry.shortcode),
  amount: parseInventoryAmount(entry.amount, entry.id),
  valuation: entry.valuation,
  verifiedAt: entry.verifiedAt,
  placement: entry.placement,
  ownershipMode: entry.ownershipMode,
  ownerLedgerPartyId: ownership.explicitOwner?.id ?? null,
  effectiveOwnership: ownership,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  dataQuality,
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
  dataQuality: DataQuality,
  locationDataQuality: DataQuality,
  ownership?: EffectiveInventoryOwnership,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (
  inventoryentry,
  pricing,
  dataQuality,
  locationDataQuality,
  ownership,
) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseFields(inventoryentry, dataQuality, ownership),
    location: {
      id: parseShortcodeFor("location", location.shortcode),
      lastBulkInventory: location.lastBulkInventory,
      aiDescription: location.aiDescription,
      images: mapImages(location.images),
      // Valuation is a whole-tree rollup; an inventory entry's embedded
      // location is a lightweight identity reference, not a place callers
      // read this location's own aggregate value from.
      valuation: null,
      name: location.name,
      aliases: location.aliases ?? [],
      notes: location.notes ?? null,
      type: parseLocationType(location.type, {
        id: location.id,
        name: location.name,
      }),
      // The inventory embed carries the holding location's own identity so a
      // stock row can render the bin it sits in without a second fetch.
      product: mapLocationIdentityProduct(location),
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
      dataQuality: locationDataQuality,
    },
    product: {
      ...mapDbProductToInventoryEmbed({
        ...product,
        pricing,
        primaryGtin: primaryGtinOf(product.externalIds),
      }),
      images: mapImages(product.images),
      externalIds: mapProductExternalIds(product.externalIds),
      unitMappings: mapProductUnitMappings(
        parseShortcodeFor("product", product.shortcode),
        product.unitMappings,
      ),
    },
    displayName: inventoryDisplayName({
      productName: product.name,
      locationName: location.name,
    }),
  };
};

export const dbInventoryEntryToListAPI: (
  inventoryentry: InventoryEntryListDB,
  pricing: ProductPricing,
  dataQuality: DataQuality,
  ownership?: EffectiveInventoryOwnership,
) => Omit<z.infer<typeof inventoryListItemOut>, "displayImages"> = (
  inventoryentry,
  pricing,
  dataQuality,
  ownership,
) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseFields(inventoryentry, dataQuality, ownership),
    location: {
      id: parseShortcodeFor("location", location.shortcode),
      name: location.name,
      type: parseLocationType(location.type, {
        id: location.id,
        name: location.name,
      }),
    },
    product: mapDbProductToInventoryList({
      ...product,
      pricing,
      primaryGtin: primaryGtinOf(product.externalIds),
    }),
    displayName: inventoryDisplayName({
      productName: product.name,
      locationName: location.name,
    }),
  };
};
