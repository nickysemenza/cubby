/**
 * Location repository helper functions.
 * Includes DB-to-API transformations and utility functions.
 */

import { extractDbTimestampsFromDBRec } from "@cubby/schemas/common";
import type { DataQuality } from "@cubby/schemas/data-quality";
import {
  type LocationId,
  type ProductId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationListItemOut,
  LocationListRefOut,
  LocationOut,
  LocationValuation,
} from "@cubby/schemas/location";
import { sumBy } from "es-toolkit";

import type { location } from "~/server/db/schema";
import {
  isNotDeleted,
  type MappableImageRecord,
  mapImages,
  mapRelation,
  parseInventoryAmount,
  type RowWithOptionalAliasesAndTags,
} from "~/server/repo/database-helpers";
import { requireLoadedProductPricing } from "~/server/repo/inventory/mappers";
import { parseLocationType } from "~/server/repo/location/parse-type";
import {
  mapDbProductToInventoryEmbed,
  primaryGtinOf,
} from "~/server/repo/product/mappers";
import type { ProductPricing } from "~/server/repo/product/pricing";

import { mapLocationIdentityProduct } from "./identity-product";
import type {
  LocationIdentityProductRow,
  LocationListDB,
  LocationWithParentChild,
} from "./internal-types";

/**
 * Transform a location DB record to API format.
 * Handles shortcode branding, type parsing, and image extraction.
 */
export const dbLocationToAPI = (
  locationData: RowWithOptionalAliasesAndTags<typeof location.$inferSelect> & {
    product?: LocationIdentityProductRow | null;
    images?: Array<{
      image: MappableImageRecord;
      deletedAt?: Date | null;
    }>;
  },
  valuations: ReadonlyMap<LocationId, LocationValuation> | undefined,
  dataQuality: DataQuality,
): LocationOut => {
  return {
    id: parseShortcodeFor("location", locationData.shortcode),
    lastBulkInventory: locationData.lastBulkInventory,
    aiDescription: locationData.aiDescription ?? null,
    name: locationData.name,
    aliases: locationData.aliases ?? [],
    tags: locationData.tags ?? [],
    notes: locationData.notes ?? null,
    type: parseLocationType(locationData.type, {
      id: locationData.id,
      name: locationData.name,
    }),
    product: mapLocationIdentityProduct(locationData),
    images: mapImages(locationData.images),
    valuation: valuations?.get(locationData.id) ?? null,
    dataQuality,
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

const dbLocationToListRef = (
  locationData: RowWithOptionalAliasesAndTags<typeof location.$inferSelect>,
): LocationListRefOut => ({
  id: parseShortcodeFor("location", locationData.shortcode),
  name: locationData.name,
  type: parseLocationType(locationData.type, {
    id: locationData.id,
    name: locationData.name,
  }),
});

export const dbLocationToListAPI = (
  locationData: LocationListDB,
  pricingByProductId: ReadonlyMap<ProductId, ProductPricing>,
  valuations: ReadonlyMap<LocationId, LocationValuation> | undefined,
  dataQuality: DataQuality,
): Omit<LocationListItemOut, "displayImages"> => ({
  ...dbLocationToAPI(locationData, valuations, dataQuality),
  parent:
    locationData.parent && isNotDeleted(locationData.parent)
      ? dbLocationToListRef(locationData.parent)
      : null,
  children: mapRelation(locationData.children, dbLocationToListRef),
  inventoryEntries: mapRelation(
    locationData.inventoryEntries.filter((entry) =>
      isNotDeleted(entry.product),
    ),
    (entry) => ({
      id: parseShortcodeFor("inventory", entry.shortcode),
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      product: mapDbProductToInventoryEmbed({
        ...entry.product,
        pricing: requireLoadedProductPricing(
          pricingByProductId,
          entry.product.id,
        ),
        primaryGtin: primaryGtinOf(entry.product.externalIds),
      }),
    }),
  ),
});

/**
 * Build a hierarchical InfLocation from a LocationWithParentChild record.
 * Recursively processes children and calculates item counts.
 */
export const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId: string | undefined,
  includeParent: boolean,
  valuations: ReadonlyMap<LocationId, LocationValuation> | undefined,
  dataQualities: ReadonlyMap<LocationId, DataQuality>,
): InfLocation => {
  const children =
    x.children && x.children.length > 0
      ? x.children
          .filter((child) => child.id !== excludeId && child.deletedAt === null)
          .map((child) =>
            buildLocationWithChildren(
              child,
              excludeId,
              includeParent,
              valuations,
              dataQualities,
            ),
          )
      : [];

  // The count IS the loaded list's length — there is no separate count input,
  // so a payload cannot report items it does not carry (see `stock-items.ts`).
  const inventoryItems = x.inventoryItems ?? [];
  const directItemCount = inventoryItems.length;
  const childrenTotalCount = sumBy(
    children,
    (child) => child.totalItemCount ?? 0,
  );

  return {
    name: x.name,
    aliases: x.aliases ?? [],
    tags: x.tags ?? [],
    notes: x.notes ?? null,
    id: parseShortcodeFor("location", x.shortcode),
    lastBulkInventory: x.lastBulkInventory,
    aiDescription: x.aiDescription ?? null,
    type: parseLocationType(x.type, { id: x.id, name: x.name }),
    product: mapLocationIdentityProduct(x),
    images: mapImages(x.images),
    valuation: valuations?.get(x.id) ?? null,
    // SAFETY: every node this recurses into is in the batch `dataQualities`
    // was loaded for (root, children, and ancestor chain — see call sites).
    dataQuality: dataQualities.get(x.id)!,
    children,
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(
            x.parent,
            excludeId,
            includeParent,
            valuations,
            dataQualities,
          )
        : undefined,
    // getLocationById queries childCount directly; the tree builder doesn't,
    // so fall back to the children it already materialized.
    childCount: x.childCount ?? children.length,
    directItemCount,
    totalItemCount: directItemCount + childrenTotalCount,
    inventoryItems,
    ...extractDbTimestampsFromDBRec(x),
  };
};
