import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { type ProductId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { EffectiveInventoryOwnership } from "@cubby/schemas/inventory-ownership";
import type { RawInventoryDetail } from "@cubby/schemas/inventory-raw-read";

import { mapImages } from "~/server/db/helpers";
import type { InventoryEntryDeepDB } from "~/server/domains/inventory/repo/types";
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

export type InventoryOwnershipTrace = {
  ownership: EffectiveInventoryOwnership;
  steps: InventoryOwnershipStep[];
};

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

/** A record read's embedded product: gallery, identifiers and unit mappings. */
export const inventoryDetailProduct = (
  product: InventoryEntryDeepDB["product"],
  pricing: ProductPricing,
  displayImages: DisplayImageSummary[],
): RawInventoryDetail["product"] => ({
  displayImages,
  ...mapDbProductToInventoryEmbed({
    ...product,
    effectivePrice: pricing.effectivePrice,
    primaryGtin: primaryGtinOf(product.externalIds),
  }),
  images: mapImages(product.images),
  externalIds: mapProductExternalIds(product.externalIds),
  unitMappings: mapProductUnitMappings(
    parseShortcodeFor("product", product.shortcode),
    product.unitMappings,
  ),
});
