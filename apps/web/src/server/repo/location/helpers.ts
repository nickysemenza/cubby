/**
 * Location repository helper functions.
 * Includes DB-to-API transformations and utility functions.
 */

import { extractDbTimestampsFromDBRec } from "@cubby/schemas/common";
import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationListItemOut,
  LocationListRefOut,
} from "@cubby/schemas/location";
import { type LocationOut, locationType } from "@cubby/schemas/location";
import { parseWithContext } from "~/lib/zod-utils";
import type { image, location } from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  isNotDeleted,
  mapRelation,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { dbProductToInventoryEmbedShape } from "~/server/repo/product/mappers";

import type { LocationListDB, LocationWithParentChild } from "./internal-types";

/**
 * Transform a location DB record to API format.
 * Handles shortcode branding, type parsing, and image extraction.
 */
export const dbLocationToAPI = (
  locationData: typeof location.$inferSelect & {
    images?: Array<{
      image: typeof image.$inferSelect;
      deletedAt?: Date | null;
    }>;
  },
): LocationOut => {
  return {
    id: locationData.id,
    shortcode: unsafeLocationShortcode(locationData.shortcode),
    lastBulkInventory: locationData.lastBulkInventory,
    aiDescription: locationData.aiDescription ?? null,
    name: locationData.name,
    type: parseWithContext(locationType, locationData.type, {
      entityType: "Location",
      identifier: { id: locationData.id, name: locationData.name },
    }),
    images: extractImagesFromJoinTable(locationData.images),
    valuation: locationData.valuation ?? null,
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

const dbLocationToListRefShape = (
  locationData: typeof location.$inferSelect,
): LocationListRefOut => ({
  id: locationData.id,
  shortcode: unsafeLocationShortcode(locationData.shortcode),
  name: locationData.name,
  type: parseWithContext(locationType, locationData.type, {
    entityType: "Location",
    identifier: { id: locationData.id, name: locationData.name },
  }),
});

export const dbLocationToListAPI = (
  locationData: LocationListDB,
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
      id: entry.id,
      amount: parseInventoryAmount(entry.amount, entry.id),
      valuation: entry.valuation,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      product: dbProductToInventoryEmbedShape(entry.product),
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
  const childrenTotalCount = children.reduce(
    (sum, child) => sum + (child.totalItemCount ?? 0),
    0,
  );

  return {
    name: x.name,
    id: x.id,
    shortcode: unsafeLocationShortcode(x.shortcode),
    lastBulkInventory: x.lastBulkInventory,
    aiDescription: x.aiDescription ?? null,
    type: parseWithContext(locationType, x.type, {
      entityType: "Location",
      identifier: { id: x.id, name: x.name },
    }),
    images: extractImagesFromJoinTable(x.images),
    valuation: x.valuation ?? null,
    children,
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(x.parent, excludeId, includeParent)
        : undefined,
    childCount: x.childCount,
    directItemCount,
    totalItemCount: directItemCount + childrenTotalCount,
    inventoryItems: x.inventoryItems ?? [],
    ...extractDbTimestampsFromDBRec(x),
  };
};
