import type { DataQuality } from "@cubby/schemas/data-quality";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { type ProductId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  inventoryDisplayName,
  type inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import type { EffectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import type { z } from "zod";

import { mapImages, parseInventoryAmount } from "~/server/db/helpers";
import type {
  InventoryEntryDeepDB,
  InventoryEntryListDB,
} from "~/server/domains/inventory/repo/types";
import { mapLocationIdentityProduct } from "~/server/domains/location/repo/identity-product";
import { parseLocationType } from "~/server/domains/location/repo/parse-type";
import {
  mapDbProductToInventoryEmbed,
  mapProductExternalIds,
  mapProductUnitMappings,
  primaryGtinOf,
} from "~/server/domains/product/repo/mappers";
import type { ProductPricing } from "~/server/domains/product/repo/pricing";

import {
  type InventoryOwnershipStep,
  inventoryOwnerResolution,
} from "./ownership";

type InventoryEntryBaseDB = Pick<
  InventoryEntryListDB,
  | "id"
  | "shortcode"
  | "amountValue"
  | "amountUnit"
  | "verifiedAt"
  | "placement"
  | "ownershipMode"
  | "createdAt"
  | "updatedAt"
>;

export type InventoryOwnershipTrace = {
  ownership: EffectiveInventoryOwnership;
  steps: InventoryOwnershipStep[];
};

/** Fallback when a caller hydrates an entry without loading its evidence. */
const unresolvedOwnership = (
  entry: InventoryEntryBaseDB,
): InventoryOwnershipTrace => ({
  ownership: {
    mode: entry.ownershipMode,
    explicitOwner: null,
    effectiveOwner: null,
    inheritedOwner: null,
    source: entry.ownershipMode === "explicit" ? "household" : "unresolved",
    evidence: null,
    evidenceFingerprint: "unresolved",
    matchesInheritedOwner: false,
  },
  steps: [],
});

const inventoryEntryBaseFields = <Q extends DataQuality | undefined>(
  entry: InventoryEntryBaseDB,
  valuation: number | null,
  dataQuality: Q,
) => ({
  id: parseShortcodeFor("inventory", entry.shortcode),
  amount: parseInventoryAmount(entry),
  valuation,
  verifiedAt: entry.verifiedAt,
  placement: entry.placement,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  dataQuality,
});

/** Map loaded ownership; list callers omit this block when evidence is unloaded. */
export const inventoryEntryOwnershipFields = ({
  ownership,
  steps,
}: InventoryOwnershipTrace) => ({
  ownerLedgerPartyId: ownership.effectiveOwner?.id ?? null,
  effectiveOwnership: ownership,
  fieldResolutions: {
    ownerLedgerPartyId: inventoryOwnerResolution(ownership, steps),
  },
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
  valuation: number | null,
  pricing: ProductPricing,
  dataQuality: DataQuality,
  locationDataQuality: DataQuality,
  ownership?: InventoryOwnershipTrace,
  displayImages?: DisplayImageSummary[],
) => z.infer<typeof inventoryWithLocationAndProductOut> = (
  inventoryentry,
  valuation,
  pricing,
  dataQuality,
  locationDataQuality,
  ownership,
  displayImages = [],
) => {
  const { product, location } = inventoryentry;

  return {
    ...inventoryEntryBaseFields(inventoryentry, valuation, dataQuality),
    ...inventoryEntryOwnershipFields(
      ownership ?? unresolvedOwnership(inventoryentry),
    ),
    location: {
      id: parseShortcodeFor("location", location.shortcode),
      lastBulkInventory: location.lastBulkInventory,
      // Like `valuation` below: the embed is a lightweight identity reference,
      // not the place callers read a location's AI description from.
      aiDescription: null,
      images: mapImages(location.images),
      // Valuation is a whole-tree rollup; an inventory entry's embedded
      // location is a lightweight identity reference, not a place callers
      // read this location's own aggregate value from.
      valuation: null,
      name: location.name,
      aliases: location.aliases ?? [],
      notes: location.notes ?? null,
      type: parseLocationType(location.type),
      // The inventory embed carries the holding location's own identity so a
      // stock row can render the bin it sits in without a second fetch.
      product: mapLocationIdentityProduct(location),
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
      dataQuality: locationDataQuality,
    },
    product: {
      displayImages,
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
