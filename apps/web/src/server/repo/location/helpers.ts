/**
 * Location repository helper functions.
 * Includes DB-to-API transformations and utility functions.
 */

import { parseWithContext } from "~/lib/zod-utils";
import { extractDbTimestampsFromDBRec } from "~/schemas/common";
import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeLocationShortcode,
  unsafeProductId,
  unsafeProductShortcode,
} from "~/schemas/identifiers";
import {
  type InfLocation,
  type LocationOut,
  type LocationOutWithParentChildren,
  locationType,
} from "~/schemas/location";
import type { image, location } from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  mapRelation,
} from "~/server/repo/database-helpers";

import type { LocationDeepDB, LocationWithParentChild } from "./internal-types";

/**
 * Transform a location DB record to API format.
 * Handles shortcode branding, type parsing, and image extraction.
 */
export const dbLocationToAPI = (
  locationData: typeof location.$inferSelect & {
    images?: Array<{ image: typeof image.$inferSelect }>;
  },
): LocationOut => {
  return {
    id: unsafeLocationId(locationData.id),
    shortcode: unsafeLocationShortcode(locationData.shortcode),
    lastBulkInventory: locationData.lastBulkInventory,
    name: locationData.name,
    type: parseWithContext(locationType, locationData.type, {
      entityType: "Location",
      identifier: { id: locationData.id, name: locationData.name },
    }),
    images: extractImagesFromJoinTable(locationData.images),
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

/**
 * Transform a deeply nested location to API format with parent/children.
 */
export const dbLocationToAPIWithChildren = (
  locationData: LocationDeepDB,
): LocationOutWithParentChildren => {
  const { parent, children, InventoryEntries, ...restOfLocation } =
    locationData;

  return {
    ...dbLocationToAPI(restOfLocation),
    parent: parent ? dbLocationToAPI(parent) : null,
    children: mapRelation(children, dbLocationToAPI),
    inventoryEntries: mapRelation(InventoryEntries, (x) => {
      const { Product, ...rest } = x;
      return {
        id: unsafeInventoryId(rest.id),
        amount: rest.amount as { value: number; unit: string },
        valuation: rest.valuation,
        createdAt: rest.createdAt,
        updatedAt: rest.updatedAt,
        product: {
          id: unsafeProductId(Product.id),
          shortcode: unsafeProductShortcode(Product.shortcode),
          name: Product.name,
          manufacturer: Product.manufacturer,
          category: Product.category,
          upc: Product.upc,
          ndb_number: Product.ndb_number,
          model: Product.model,
          expectedQuantity: Product.expectedQuantity,
          price: Product.price,
          // Product images are not fetched in this query for performance reasons
          // If product images are needed, use a separate query or join
          images: [],
          createdAt: Product.createdAt,
          updatedAt: Product.updatedAt,
        },
      };
    }),
  };
};

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
    id: unsafeLocationId(x.id),
    shortcode: unsafeLocationShortcode(x.shortcode),
    lastBulkInventory: x.lastBulkInventory,
    type: parseWithContext(locationType, x.type, {
      entityType: "Location",
      identifier: { id: x.id, name: x.name },
    }),
    images: extractImagesFromJoinTable(x.images),
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
