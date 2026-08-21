/**
 * Location repository helper functions.
 * Includes DB-to-API transformations and utility functions.
 */

import { extractDbTimestampsFromDBRec } from "@cubby/schemas/common";
import {
  type ProductId,
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationListItemOut,
  LocationListRefOut,
  LocationOut,
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
import { dbProductToInventoryEmbedShape } from "~/server/repo/product/mappers";
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
): LocationOut => {
  return {
    id: unsafeLocationShortcode(locationData.shortcode),
    lastBulkInventory: locationData.lastBulkInventory,
    aiDescription: locationData.aiDescription ?? null,
    name: locationData.name,
    aliases: locationData.aliases ?? [],
    tags: locationData.tags ?? [],
    type: parseLocationType(locationData.type, {
      id: locationData.id,
      name: locationData.name,
    }),
    product: mapLocationIdentityProduct(locationData),
    images: mapImages(locationData.images),
    valuation: locationData.valuation ?? null,
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

const dbLocationToListRefShape = (
  locationData: RowWithOptionalAliasesAndTags<typeof location.$inferSelect>,
): LocationListRefOut => ({
  id: unsafeLocationShortcode(locationData.shortcode),
  name: locationData.name,
  type: parseLocationType(locationData.type, {
    id: locationData.id,
    name: locationData.name,
  }),
});

export const dbLocationToListAPI = (
  locationData: LocationListDB,
  pricingByProductId: ReadonlyMap<ProductId, ProductPricing>,
): LocationListItemOut => ({
  ...dbLocationToAPI(locationData),
  parent:
    locationData.parent && isNotDeleted(locationData.parent)
      ? dbLocationToListRefShape(locationData.parent)
      : null,
  children: mapRelation(locationData.children, dbLocationToListRefShape),
  inventoryEntries: mapRelation(
    locationData.inventoryEntries.filter((entry) =>
      isNotDeleted(entry.product),
    ),
    (entry) => ({
      id: unsafeInventoryShortcode(entry.shortcode),
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      product: dbProductToInventoryEmbedShape({
        ...entry.product,
        pricing: requireLoadedProductPricing(
          pricingByProductId,
          entry.product.id,
        ),
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
  excludeId?: string,
  includeParent = true,
): InfLocation => {
  const children =
    x.children && x.children.length > 0
      ? x.children
          .filter((child) => child.id !== excludeId && child.deletedAt === null)
          .map((child) =>
            buildLocationWithChildren(child, excludeId, includeParent),
          )
      : [];

  const directItemCount = x.directItemCount ?? 0;
  const childrenTotalCount = sumBy(
    children,
    (child) => child.totalItemCount ?? 0,
  );

  return {
    name: x.name,
    aliases: x.aliases ?? [],
    tags: x.tags ?? [],
    id: unsafeLocationShortcode(x.shortcode),
    lastBulkInventory: x.lastBulkInventory,
    aiDescription: x.aiDescription ?? null,
    type: parseLocationType(x.type, { id: x.id, name: x.name }),
    product: mapLocationIdentityProduct(x),
    images: mapImages(x.images),
    valuation: x.valuation ?? null,
    children,
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(x.parent, excludeId, includeParent)
        : undefined,
    // getLocationById queries childCount directly; the tree builder doesn't,
    // so fall back to the children it already materialized.
    childCount: x.childCount ?? children.length,
    directItemCount,
    totalItemCount: directItemCount + childrenTotalCount,
    inventoryItems: x.inventoryItems ?? [],
    ...extractDbTimestampsFromDBRec(x),
  };
};
